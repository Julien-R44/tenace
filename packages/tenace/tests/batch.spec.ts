import { test } from '@japa/runner'

import { UnexpectedError } from '../src/errors.ts'
import { err, ok } from '../src/result.ts'
import { Tenace } from '../src/tenace.ts'
import { NotFound } from './helpers/strategies.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test.group('Batch | Tenace.all', () => {
  test('execute resolves with the values in order', async ({ assert }) => {
    const values = await Tenace.all([
      async () => {
        await tick()
        return 'slow'
      },
      () => 'fast',
      () => ok(3),
    ]).execute()
    assert.deepEqual(values, ['slow', 'fast', 3])
  })

  test('execute is fail-fast: rejects with the first failure and aborts siblings', async ({
    assert,
  }) => {
    const raw = new Error('boom')
    let siblingSignal: AbortSignal | undefined
    let notStarted = false
    const thrown = await Tenace.all(
      [
        ({ signal }) => {
          siblingSignal = signal
          return new Promise(() => {})
        },
        async () => {
          await tick()
          throw raw
        },
        () => (notStarted = true),
      ],
      { concurrency: 2 },
    )
      .execute()
      .catch((error: unknown) => error)

    assert.strictEqual(thrown, raw)
    assert.isTrue(siblingSignal?.aborted)
    assert.equal((siblingSignal!.reason as DOMException).name, 'AbortError')
    await tick()
    assert.isFalse(notStarted)
  })

  test('settle runs every task and returns one Result per task', async ({ assert }) => {
    const notFound = new NotFound('x')
    const results = await Tenace.all([
      () => 1,
      () => err(notFound),
      () => {
        throw new Error('raw')
      },
    ]).settle()
    assert.deepEqual(results[0], ok(1))
    assert.deepEqual(results[1], err(notFound))
    assert.isTrue(!results[2].ok && results[2].error instanceof UnexpectedError)
  })

  test('tasks run through the policy', async ({ assert }) => {
    const calls = [0, 0]
    const policy = Tenace.policy().withRetry({ retries: 2, delay: 0 })
    const values = await Tenace.all(
      [() => (++calls[0]! < 3 ? err('retry me') : 'a'), () => (++calls[1]!, 'b')],
      { policy },
    ).execute()
    assert.deepEqual(values, ['a', 'b'])
    assert.deepEqual(calls, [3, 1])
  })

  test('concurrency bounds the tasks running at the same time', async ({ assert }) => {
    let running = 0
    let peak = 0
    const task = async () => {
      running++
      peak = Math.max(peak, running)
      await tick()
      running--
      return peak
    }
    await Tenace.all([task, task, task, task, task], { concurrency: 2 }).settle()
    assert.equal(peak, 2)
  })

  test('the caller signal aborts the whole batch', async ({ assert }) => {
    const controller = new AbortController()
    const signals: AbortSignal[] = []
    const settled = Tenace.all([
      ({ signal }) => (signals.push(signal), new Promise(() => {})),
      ({ signal }) => (signals.push(signal), new Promise(() => {})),
    ]).settle({ signal: controller.signal })
    await tick()
    controller.abort('stop')
    assert.equal(await settled.catch((error: unknown) => error), 'stop')
    assert.isTrue(signals.every(signal => signal.aborted))
  })

  test('an empty batch resolves right away', async ({ assert }) => {
    assert.deepEqual(await Tenace.all([]).execute(), [])
    assert.deepEqual(await Tenace.all([]).settle(), [])
  })

  test('policy.isError recognizes known errors rejected by a batch', async ({ assert }) => {
    const policy = Tenace.policy()
    const thrown = await Tenace.all([() => err(new NotFound('x'))], { policy })
      .execute()
      .catch((error: unknown) => error)
    assert.isTrue(policy.isError(thrown))
  })

  test('large batches cost linear time, also when aborted', async ({ assert }) => {
    const tasks = Array.from({ length: 20_000 }, () => () => 1)
    let started = performance.now()
    await Tenace.all(tasks, { concurrency: 1 }).execute()
    assert.isBelow(performance.now() - started, 1000)

    const controller = new AbortController()
    const pending = Tenace.all(
      tasks.map(() => () => new Promise(() => {})),
      { concurrency: 1 },
    ).settle({ signal: controller.signal })
    await tick()
    started = performance.now()
    controller.abort('stop')
    assert.equal(await pending.catch((error: unknown) => error), 'stop')
    assert.isBelow(performance.now() - started, 1000)
  })

  test('rejects an invalid concurrency', ({ assert }) => {
    assert.throws(() => Tenace.all([], { concurrency: 0 }), RangeError)
  })
})

test.group('Batch | Tenace.map', () => {
  test('maps every item with its index, in order', async ({ assert }) => {
    const values = await Tenace.map(['a', 'b', 'c'], async (item, _context, index) => {
      await tick()
      return `${item}${index}`
    }).execute()
    assert.deepEqual(values, ['a0', 'b1', 'c2'])
  })

  test('accepts any iterable and settles every item', async ({ assert }) => {
    const results = await Tenace.map(new Set([1, 2]), item =>
      item === 2 ? err('two') : item * 10,
    ).settle()
    assert.deepEqual(results, [ok(10), err('two')])
  })
})
