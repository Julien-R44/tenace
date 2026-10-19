import { test } from '@japa/runner'

import { TimeoutError } from '../src/errors.ts'
import { systemClock } from '../src/clock.ts'
import { err, ok } from '../src/result.ts'
import { Timeout } from '../src/strategies/timeout.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'
import { sleep } from '../src/internal/sleep.ts'
import { Twice } from './helpers/strategies.ts'

const never = () => new Promise<never>(() => {})

/**
 * Errors given to `globalThis.reportError` while `run` runs.
 */
async function captureReported(run: () => Promise<void>): Promise<unknown[]> {
  const holder = globalThis as { reportError?: (error: unknown) => void }
  const original = holder.reportError
  const reported: unknown[] = []
  holder.reportError = error => reported.push(error)
  try {
    await run()
    await sleep(systemClock, 1)
    return reported
  } finally {
    if (original) holder.reportError = original
    else delete holder.reportError
  }
}

test.group('Timeout | aggressive', () => {
  test('returns TimeoutError at the deadline even if fn ignores its signal', async ({ assert }) => {
    const clock = new TestClock()
    let fnSignal: AbortSignal | undefined
    const settled = Tenace.policy()
      .withTimeout(100)
      .settle(
        ({ signal }) => {
          fnSignal = signal
          return never()
        },
        { clock },
      )

    await clock.advance(99)
    assert.isFalse(fnSignal?.aborted)
    await clock.advance(1)

    const result = await settled
    assert.isFalse(result.ok)
    if (result.ok) return
    assert.instanceOf(result.error, TimeoutError)
    assert.equal((result.error as TimeoutError).timeoutMs, 100)
    assert.isTrue(fnSignal?.aborted)
    assert.strictEqual(fnSignal?.reason, result.error)
  })

  test('keeps the result of a function faster than the deadline and clears its timer', async ({
    assert,
  }) => {
    const clock = new TestClock()
    const result = await Tenace.policy()
      .withTimeout('1s')
      .settle(() => 'fast', { clock })
    assert.deepEqual(result, ok('fast'))
    assert.equal(clock.pendingTimers, 0)
  })

  test('works on the system clock', async ({ assert }) => {
    const start = performance.now()
    const thrown = await Tenace.policy()
      .withTimeout(20)
      .execute(never)
      .catch((error: unknown) => error)
    assert.instanceOf(thrown, TimeoutError)
    assert.isAtLeast(performance.now() - start, 15)
  })

  test('the fn signal is not aborted after a successful completion', async ({ assert }) => {
    const controller = new AbortController()
    const signal = await Tenace.policy()
      .withTimeout('1s')
      .execute(ctx => ctx.signal, { signal: controller.signal })
    controller.abort()
    assert.isFalse(signal.aborted)
  })

  test('the caller abort reaches the fn through the timeout', async ({ assert }) => {
    const controller = new AbortController()
    let fnSignal: AbortSignal | undefined
    const settled = Tenace.policy()
      .withTimeout('1s')
      .settle(
        ({ signal }) => {
          fnSignal = signal
          return never()
        },
        { signal: controller.signal },
      )
    controller.abort('stop')
    assert.equal(await settled.catch((error: unknown) => error), 'stop')
    assert.equal(fnSignal?.reason, 'stop')
  })

  test('stops waiting and clears its timer as soon as the caller aborts', async ({ assert }) => {
    const clock = new TestClock()
    const controller = new AbortController()
    const settled = Tenace.policy()
      .withTimeout('3s')
      .settle(never, { clock, signal: controller.signal })
    controller.abort('stop')
    assert.equal(await settled.catch((error: unknown) => error), 'stop')
    await clock.advance(0)
    assert.equal(clock.pendingTimers, 0)
  })

  test('a defect after the deadline is reported', async ({ assert }) => {
    const clock = new TestClock()
    const bug = new Error('bug in mapper')
    const reported = await captureReported(async () => {
      const settled = Tenace.policy()
        .mapError(() => {
          throw bug
        })
        .withTimeout(10)
        .settle(() => new Promise(resolve => clock.setTimeout(() => resolve(err('late')), 20)), {
          clock,
        })
      await clock.advance(10)
      const result = await settled
      assert.instanceOf(!result.ok && result.error, TimeoutError)
      await clock.advance(10)
    })
    assert.deepEqual(reported, [bug])
  })

  test('Infinity disables the timer', async ({ assert }) => {
    const clock = new TestClock()
    const result = await Tenace.policy()
      .withTimeout(Number.POSITIVE_INFINITY)
      .settle(
        async ctx => {
          assert.equal(clock.pendingTimers, 0)
          return ctx.signal.aborted
        },
        { clock },
      )
    assert.deepEqual(result, ok(false))
  })

  test('rejects invalid durations when the policy is built', ({ assert }) => {
    assert.throws(() => Tenace.policy().withTimeout(-1), RangeError)
    assert.throws(() => new Timeout('soon' as never), RangeError)
  })

  test('rejects an invalid mode when the policy is built', ({ assert }) => {
    assert.throws(
      () => Tenace.policy().withTimeout(10, { mode: 'aggresive' as never }),
      RangeError,
      /Invalid timeout mode: aggresive/,
    )
  })
})

test.group('Timeout | cooperative', () => {
  test('aborts at the deadline but waits for the function to settle', async ({ assert }) => {
    const clock = new TestClock()
    let finished = false
    const settled = Tenace.policy()
      .withTimeout(100, { mode: 'cooperative' })
      .settle(
        async ({ signal }) => {
          await sleep(clock, 150)
          finished = true
          signal.throwIfAborted()
        },
        { clock },
      )

    await clock.advance(100)
    await clock.advance(50)
    const result = await settled
    assert.isTrue(finished)
    assert.isTrue(!result.ok && result.error instanceof TimeoutError)
  })

  test('keeps a success that arrives after the deadline', async ({ assert }) => {
    const clock = new TestClock()
    const settled = Tenace.policy()
      .withTimeout(100, { mode: 'cooperative' })
      .settle(
        async ({ signal }) => {
          await sleep(clock, 150)
          return signal.aborted
        },
        { clock },
      )
    await clock.advance(150)
    assert.deepEqual(await settled, ok(true))
  })
})

test.group('Timeout | position', () => {
  test('inside a repeating strategy it bounds each attempt, outside it bounds the total', async ({
    assert,
  }) => {
    const clock = new TestClock()
    const starts: number[] = []
    const fn = async ({ signal }: { signal: AbortSignal }) => {
      starts.push(clock.now())
      await sleep(clock, 80, signal)
      signal.throwIfAborted()
      return 'done'
    }

    const perAttempt = Tenace.policy().withTimeout(50).with(new Twice())
    const settledPerAttempt = perAttempt.settle(fn, { clock })
    await clock.advance(200)
    const r1 = await settledPerAttempt
    assert.isTrue(!r1.ok && r1.error instanceof TimeoutError)
    assert.deepEqual(starts, [0, 50])

    starts.length = 0
    const total = Tenace.policy().with(new Twice()).withTimeout(100)
    const settledTotal = total.settle(fn, { clock })
    await clock.advance(200)
    const r2 = await settledTotal
    assert.isTrue(!r2.ok && r2.error instanceof TimeoutError)
    assert.deepEqual(starts, [200, 280])
  })
})
