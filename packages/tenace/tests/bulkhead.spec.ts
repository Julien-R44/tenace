import { test } from '@japa/runner'

import { ExecutionContext } from '../src/context.ts'
import { BulkheadFullError, UnexpectedError } from '../src/errors.ts'
import { type AnyResult, ok } from '../src/result/core.ts'
import { Bulkhead } from '../src/strategies/bulkhead.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'

/**
 * Calls that stay pending until released one by one.
 */
function gate() {
  const waiting: (() => void)[] = []
  const started: number[] = []
  let count = 0
  const fn = () => {
    const id = ++count
    started.push(id)
    return new Promise<number>(resolve => waiting.push(() => resolve(id)))
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  return {
    fn,
    started,
    releaseNext: async () => {
      waiting.shift()?.()
      await flush()
    },
    flush,
  }
}

test.group('Bulkhead', () => {
  test('runs at most `concurrency` calls and rejects the rest when there is no queue', async ({
    assert,
  }) => {
    const bulkhead = new Bulkhead({ concurrency: 2 })
    const policy = Tenace.policy().with(bulkhead)
    const calls = gate()

    const a = policy.settle(calls.fn)
    const b = policy.settle(calls.fn)
    await calls.flush()
    const rejected = await policy.settle(calls.fn)

    assert.equal(bulkhead.running, 2)
    assert.isTrue(!rejected.ok && rejected.error instanceof BulkheadFullError)
    assert.equal((rejected as { error: BulkheadFullError }).error.running, 2)
    assert.deepEqual(calls.started, [1, 2])

    await calls.releaseNext()
    await calls.releaseNext()
    assert.deepEqual(await Promise.all([a, b]), [ok(1), ok(2)])
    assert.equal(bulkhead.running, 0)
  })

  test('queued calls run in FIFO order when slots free up', async ({ assert }) => {
    const bulkhead = new Bulkhead({ concurrency: 1, queue: 2 })
    const policy = Tenace.policy().with(bulkhead)
    const calls = gate()

    const results = [policy.settle(calls.fn), policy.settle(calls.fn), policy.settle(calls.fn)]
    await calls.flush()
    assert.equal(bulkhead.queued, 2)
    const overflow = await policy.settle(calls.fn)
    assert.isTrue(!overflow.ok && overflow.error instanceof BulkheadFullError)

    await calls.releaseNext()
    assert.deepEqual(calls.started, [1, 2])
    await calls.releaseNext()
    await calls.releaseNext()
    assert.deepEqual(await Promise.all(results), [ok(1), ok(2), ok(3)])
    assert.equal(bulkhead.queued, 0)
    assert.equal(bulkhead.running, 0)
  })

  test('a call waiting longer than maxWait is rejected', async ({ assert }) => {
    const clock = new TestClock()
    const policy = Tenace.policy().withBulkhead({ concurrency: 1, queue: 1, maxWait: 100 })
    const calls = gate()

    const first = policy.settle(calls.fn, { clock })
    const waiting = policy.settle(calls.fn, { clock })
    await clock.advance(100)
    const result = await waiting
    assert.isTrue(!result.ok && result.error instanceof BulkheadFullError)
    assert.deepEqual(calls.started, [1])

    await calls.releaseNext()
    assert.deepEqual(await first, ok(1))
    assert.equal(clock.pendingTimers, 0)
  })

  test('an aborted queued call leaves the queue', async ({ assert }) => {
    const bulkhead = new Bulkhead({ concurrency: 1, queue: 5 })
    const policy = Tenace.policy().with(bulkhead)
    const calls = gate()
    const controller = new AbortController()

    const first = policy.settle(calls.fn)
    const aborted = policy.settle(calls.fn, { signal: controller.signal })
    const third = policy.settle(calls.fn)
    await calls.flush()
    controller.abort('stop')
    assert.equal(await aborted.catch((error: unknown) => error), 'stop')
    assert.equal(bulkhead.queued, 1)

    await calls.releaseNext()
    assert.deepEqual(calls.started, [1, 2])
    await calls.releaseNext()
    assert.deepEqual(await Promise.all([first, third]), [ok(1), ok(2)])
  })

  test('a call aborted in the tick its slot is granted does not run', async ({ assert }) => {
    const bulkhead = new Bulkhead({ concurrency: 1, queue: 1 })
    const controller = new AbortController()
    let finish!: () => void
    const holding = new Promise<AnyResult>(resolve => (finish = () => resolve(ok('done'))))
    const holder = bulkhead.execute(
      new ExecutionContext({ signal: new AbortController().signal }),
      () => holding,
    )
    let called = false
    const waiting = bulkhead.execute(
      new ExecutionContext({ signal: controller.signal }),
      async () => {
        called = true
        return ok('ran')
      },
    )

    // the slot is granted when the holder settles, the abort lands before the waiter resumes
    await new Promise(resolve => setTimeout(resolve, 0))
    finish()
    queueMicrotask(() => controller.abort('gave up'))
    await holder
    const result = await waiting
    assert.isFalse(called)
    assert.isTrue(!result.ok && result.error instanceof UnexpectedError)
    assert.equal(bulkhead.running, 0)
  })

  test('an inner bulkhead aborted by an outer timeout returns', async ({ assert }) => {
    const clock = new TestClock()
    const policy = Tenace.policy()
      .withBulkhead({ concurrency: 1, queue: 1 })
      .withTimeout(50, { mode: 'cooperative' })
    const calls = gate()

    void policy.settle(calls.fn, { clock })
    const queued = policy.settle(calls.fn, { clock })
    await clock.advance(50)
    const result = await queued
    assert.isFalse(result.ok)
    assert.notInstanceOf((result as { error: unknown }).error, UnexpectedError)
  })

  test('the slot is released when an inner step rejects with a bug', async ({ assert }) => {
    const bulkhead = new Bulkhead({ concurrency: 1 })
    const buggy = Tenace.policy()
      .withFallback(() => {
        throw new Error('bug')
      })
      .with(bulkhead)
    await buggy
      .settle(() => {
        throw new Error('x')
      })
      .catch(() => {})
    assert.equal(bulkhead.running, 0)
  })

  test('a shared instance limits every policy using it', async ({ assert }) => {
    const bulkhead = new Bulkhead({ concurrency: 1 })
    const calls = gate()
    const a = Tenace.policy().with(bulkhead).settle(calls.fn)
    const b = await Tenace.policy().withTimeout(1000).withBulkhead(bulkhead).settle(calls.fn)
    assert.isTrue(!b.ok && b.error instanceof BulkheadFullError)
    await calls.releaseNext()
    await a
  })

  test('rejects invalid options', ({ assert }) => {
    assert.throws(() => new Bulkhead({ concurrency: 0 }), RangeError)
    assert.throws(() => new Bulkhead({ concurrency: 1, queue: -1 }), RangeError)
    assert.doesNotThrow(() => new Bulkhead({ concurrency: 1, queue: Number.POSITIVE_INFINITY }))
  })
})
