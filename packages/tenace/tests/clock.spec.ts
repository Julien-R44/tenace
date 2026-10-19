import { test } from '@japa/runner'

import { systemClock } from '../src/clock.ts'
import { sleep } from '../src/internal/sleep.ts'
import { TestClock } from '../src/testing/test_clock.ts'

test.group('TestClock', () => {
  test('fires due timers in time order, then insertion order', async ({ assert }) => {
    const clock = new TestClock()
    const fired: string[] = []
    clock.setTimeout(() => fired.push('b@20'), 20)
    clock.setTimeout(() => fired.push('a@10'), 10)
    clock.setTimeout(() => fired.push('c@20'), 20)
    clock.setTimeout(() => fired.push('d@30'), 30)

    await clock.advance(20)
    assert.deepEqual(fired, ['a@10', 'b@20', 'c@20'])
    assert.equal(clock.now(), 20)
    assert.equal(clock.pendingTimers, 1)
  })

  test('now() equals the timer time while it fires', async ({ assert }) => {
    const clock = new TestClock(1000)
    const seen: number[] = []
    clock.setTimeout(() => seen.push(clock.now()), 5)
    await clock.advance(50)
    assert.deepEqual(seen, [1005])
    assert.equal(clock.now(), 1050)
  })

  test('timers scheduled by promise continuations inside the window fire too', async ({
    assert,
  }) => {
    const clock = new TestClock()
    const steps: number[] = []
    const run = async () => {
      for (let i = 0; i < 3; i++) {
        await sleep(clock, 10)
        steps.push(clock.now())
      }
    }
    const done = run()
    await clock.advance(25)
    assert.deepEqual(steps, [10, 20])
    await clock.advance(5)
    await done
    assert.deepEqual(steps, [10, 20, 30])
  })

  test('clearTimeout cancels a timer', async ({ assert }) => {
    const clock = new TestClock()
    let fired = false
    const handle = clock.setTimeout(() => (fired = true), 10)
    clock.clearTimeout(handle)
    await clock.advance(100)
    assert.isFalse(fired)
    assert.equal(clock.pendingTimers, 0)
  })

  test('runAll drains timers and detects loops', async ({ assert }) => {
    const clock = new TestClock()
    let count = 0
    clock.setTimeout(() => count++, 1_000_000)
    await clock.runAll()
    assert.equal(count, 1)
    assert.equal(clock.now(), 1_000_000)

    const loop = () => void clock.setTimeout(loop, 1)
    loop()
    await assert.rejects(() => clock.runAll(50), /more than 50 timers/)
  })

  test('timers of Infinity never fire, NaN delays fire right away', async ({ assert }) => {
    const clock = new TestClock()
    const fired: string[] = []
    clock.setTimeout(() => fired.push('never'), Number.POSITIVE_INFINITY)
    clock.setTimeout(() => fired.push(`nan@${clock.now()}`), Number.NaN)

    await clock.runAll()
    assert.deepEqual(fired, ['nan@0'])
    assert.equal(clock.now(), 0)
    assert.equal(clock.pendingTimers, 1)
  })

  test('advance accepts durations and rejects negative or infinite ones', async ({ assert }) => {
    const clock = new TestClock()
    await clock.advance('1.5s')
    assert.equal(clock.now(), 1500)

    await assert.rejects(() => clock.advance(-500), RangeError)
    await assert.rejects(() => clock.advance(Number.NaN), RangeError)
    await assert.rejects(() => clock.advance(Number.POSITIVE_INFINITY), RangeError)
    assert.equal(clock.now(), 1500)
  })
})

test.group('systemClock', () => {
  test('chains delays beyond the timer limit and never schedules Infinity', ({ assert }) => {
    const limit = 2 ** 31 - 1
    const native = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
    const scheduled: { id: number; ms: number; fire: () => void }[] = []
    const cleared: unknown[] = []
    globalThis.setTimeout = ((fire: () => void, ms: number) => {
      scheduled.push({ id: scheduled.length + 1, ms, fire })
      return scheduled.length
    }) as never
    globalThis.clearTimeout = ((id: unknown) => void cleared.push(id)) as never

    try {
      let fired = 0
      systemClock.setTimeout(() => fired++, Number.POSITIVE_INFINITY)
      systemClock.setTimeout(() => fired++, limit * 2 + 10)
      for (let i = 0; i < 3; i++) scheduled.at(-1)!.fire()
      assert.deepEqual(
        scheduled.map(timer => timer.ms),
        [limit, limit, 10],
      )
      assert.equal(fired, 1)

      const handle = systemClock.setTimeout(() => fired++, limit + 1)
      scheduled.at(-1)!.fire()
      systemClock.clearTimeout(handle)
      assert.deepEqual(cleared, [scheduled.at(-1)!.id])
      assert.equal(fired, 1)
    } finally {
      Object.assign(globalThis, native)
    }
  })
})

test.group('sleep', () => {
  test('resolves true once the delay elapsed', async ({ assert }) => {
    const clock = new TestClock()
    let settled: boolean | undefined
    void sleep(clock, 100).then(value => (settled = value))

    await clock.advance(99)
    assert.isUndefined(settled)
    await clock.advance(1)
    assert.isTrue(settled)
  })

  test('resolves false as soon as the signal aborts and clears its timer', async ({ assert }) => {
    const clock = new TestClock()
    const controller = new AbortController()
    const pending = sleep(clock, 1000, controller.signal)

    controller.abort()
    assert.isFalse(await pending)
    assert.equal(clock.pendingTimers, 0)
  })

  test('resolves false immediately for an already aborted signal', async ({ assert }) => {
    const clock = new TestClock()
    assert.isFalse(await sleep(clock, 1000, AbortSignal.abort()))
    assert.equal(clock.pendingTimers, 0)
  })

  test('Infinity only ends with the signal', async ({ assert }) => {
    const clock = new TestClock()
    const controller = new AbortController()
    const pending = sleep(clock, Number.POSITIVE_INFINITY, controller.signal)
    assert.equal(clock.pendingTimers, 0)
    controller.abort()
    assert.isFalse(await pending)
  })

  test('works on the system clock', async ({ assert }) => {
    const start = performance.now()
    assert.isTrue(await sleep(systemClock, 20))
    assert.isAtLeast(performance.now() - start, 15)
  })
})
