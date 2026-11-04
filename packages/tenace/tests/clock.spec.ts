import { test } from '@japa/runner'
import { setImmediate } from 'node:timers/promises'
import { clock as sharedClock, Clock } from '../src/clock/clock.ts'
import { SystemClock } from '../src/clock/system_clock.ts'
import { TimeoutError } from '../src/errors.ts'
import { sleep } from '../src/internal/sleep.ts'
import { CircuitBreaker } from '../src/strategies/circuit_breaker/circuit_breaker.ts'
import { Tenace } from '../src/tenace.ts'
import { backoff } from '../src/backoff.ts'
import { fakeClock } from './helpers/fake_clock.ts'

const START = new Date('2026-01-01T10:00:00.000Z')

test.group('Clock', () => {
  test('reads the system time until faked', async ({ assert }) => {
    const clock = new Clock()

    assert.closeTo(clock.now().epochMilliseconds, Date.now(), 50)
    assert.closeTo(clock.monotonic(), performance.now(), 50)

    clock.fake(START)
    assert.equal(clock.now().toString(), '2026-01-01T10:00:00Z')

    clock.restore()
    assert.closeTo(clock.now().epochMilliseconds, Date.now(), 50)
  })

  test('restores the system time when the fake is disposed', async ({ assert }) => {
    const clock = new Clock()

    {
      using time = clock.fake(START)
      await time.advanceBy('1 hour')
      assert.equal(clock.now().toString(), '2026-01-01T11:00:00Z')
    }

    assert.closeTo(clock.now().epochMilliseconds, Date.now(), 50)
  })

  test('waits for real time with a duration expression', async ({ assert }) => {
    const clock = new Clock()
    const start = performance.now()

    await clock.wait('30ms')

    assert.isAtLeast(performance.now() - start, 25)
  })

  test('aborts a system deadline once its duration passes', async ({ assert }) => {
    const clock = new Clock()
    const deadline = clock.timeout(20)

    await clock.wait(40)

    assert.isTrue(deadline.signal.aborted)
    assert.equal(deadline.signal.reason.name, 'TimeoutError')
  })
})

test.group('Clock | fake', () => {
  test('moves the calendar and monotonic times together', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START)

    await time.advanceBy('90 minutes')

    assert.equal(clock.now().toString(), '2026-01-01T11:30:00Z')
    assert.equal(clock.monotonic(), 90 * 60_000)
  })

  test('setTime moves the calendar time only', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START)
    let woke = false
    void clock.wait(1000).then(() => (woke = true))

    await time.advanceBy(400)
    time.setTime(new Date('2027-06-01T00:00:00Z'))
    await setImmediate()

    assert.equal(clock.now().toString(), '2027-06-01T00:00:00Z')
    assert.equal(clock.monotonic(), 400)
    assert.isFalse(woke)

    await time.advanceBy(600)
    assert.equal(clock.now().toString(), '2027-06-01T00:00:00.6Z')
    assert.isTrue(woke)
  })

  test('fires only the timers due within the advance, by due time then FIFO', async ({
    assert,
  }) => {
    const clock = new Clock()
    const time = clock.fake(START)
    const fired: string[] = []

    void clock.wait(300).then(() => fired.push('300'))
    void clock.wait(100).then(() => fired.push('100 first'))
    void clock.wait(100).then(() => fired.push('100 second'))
    void clock.wait(201).then(() => fired.push('201'))

    await time.advanceBy(200)
    assert.deepEqual(fired, ['100 first', '100 second'])

    await time.advanceBy(100)
    assert.deepEqual(fired, ['100 first', '100 second', '201', '300'])
  })

  test('runs each step of a loop that waits between steps', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START)
    const runs: string[] = []

    void (async () => {
      for (let step = 0; step < 10; step++) {
        await clock.wait('1 minute')
        await Promise.resolve()
        runs.push(clock.now().toString())
      }
    })()

    await time.advanceBy('3 minutes')

    assert.deepEqual(runs, ['2026-01-01T10:01:00Z', '2026-01-01T10:02:00Z', '2026-01-01T10:03:00Z'])
  })

  test('rejects an aborted wait the way Node.js timers do', async ({ assert }) => {
    const clock = new Clock()
    clock.fake(START)
    const controller = new AbortController()

    const wait = clock.wait(1000, controller.signal)
    controller.abort('stopped')

    const error = await wait.catch(reason => reason)
    assert.equal(error.name, 'AbortError')
    assert.equal(error.code, 'ABORT_ERR')
    assert.equal(error.cause, 'stopped')
  })

  test('aborts deadlines on time and forgets disposed ones', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START)

    const kept = clock.timeout('1s')
    const disposed = clock.timeout('1s')
    assert.equal(time.pendingDeadlines, 2)

    disposed[Symbol.dispose]()
    await time.advanceBy(999)
    assert.isFalse(kept.signal.aborted)
    assert.equal(time.pendingDeadlines, 1)

    await time.advanceBy(1)
    assert.isTrue(kept.signal.aborted)
    assert.equal(kept.signal.reason.name, 'TimeoutError')
    assert.isFalse(disposed.signal.aborted)
    assert.equal(time.pendingDeadlines, 0)
  })

  test('nextWait resolves once the code under test waits', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START)
    const steps: string[] = []

    const waited = time.nextWait()
    void (async () => {
      await setImmediate()
      steps.push('working')
      await clock.wait(10)
    })()

    await waited
    assert.deepEqual(steps, ['working'])
  })

  test('letTimePass ends each wait at once, across real I/O', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START).letTimePass()

    for (let step = 0; step < 3; step++) {
      await new Promise(resolve => setTimeout(resolve, 1))
      await clock.wait('1 hour')
    }

    assert.equal(clock.now().toString(), '2026-01-01T13:00:00Z')
    assert.equal(time.pendingDeadlines, 0)
  })
})

test.group('Clock | until', () => {
  test('returns the first observed value, observing every interval', async ({ assert }) => {
    const clock = new Clock()
    clock.fake(START).letTimePass()
    const observedAt: number[] = []

    const value = await clock.until(
      async () => {
        observedAt.push(clock.monotonic())
        return observedAt.length === 3 ? 'ready' : undefined
      },
      { within: '1 minute', every: '10s' },
    )

    assert.equal(value, 'ready')
    assert.deepEqual(observedAt, [0, 10_000, 20_000])
  })

  test('returns null once within passes, with a last wait cut to the deadline', async ({
    assert,
  }) => {
    const clock = new Clock()
    const time = clock.fake(START).letTimePass()
    const observedAt: number[] = []

    const value = await clock.until(
      async () => {
        observedAt.push(clock.monotonic())
        return undefined
      },
      { within: 25_000, every: 10_000 },
    )

    assert.isNull(value)
    assert.deepEqual(observedAt, [0, 10_000, 20_000])
    assert.equal(clock.monotonic(), 25_000)
    assert.equal(time.pendingDeadlines, 0)
  })

  test('returns null when the deadline cuts an observation short', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START)

    const result = clock.until(
      signal =>
        new Promise<string>(resolve => {
          signal.addEventListener('abort', () => resolve('too late'))
        }),
      { within: '5s', every: '1s' },
    )
    await time.advanceBy('5s')

    assert.isNull(await result)
  })

  test('throws the reason of a caller that aborts', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START)
    const controller = new AbortController()

    const result = clock.until(async () => undefined, {
      within: '1 minute',
      every: '1s',
      signal: controller.signal,
    })
    await time.advanceBy('2s')
    controller.abort(new Error('cancelled by caller'))

    await assert.rejects(() => result, 'cancelled by caller')
    assert.equal(time.pendingDeadlines, 0)
  })
})

test.group('Clock | until in Tenace', () => {
  test('every accepts a backoff of the number of observations', async ({ assert }) => {
    const clock = new Clock()
    clock.fake(START).letTimePass()
    const observedAt: number[] = []

    const value = await clock.until(
      () => {
        observedAt.push(clock.monotonic())
        return observedAt.length === 4 ? 'ready' : undefined
      },
      { within: '1 minute', every: backoff.exponential({ base: '1s', jitter: 'none' }) },
    )

    assert.equal(value, 'ready')
    assert.deepEqual(observedAt, [0, 1000, 3000, 7000])
  })

  test('returns null at the deadline when the observation ignores its signal', async ({
    assert,
  }) => {
    const clock = new Clock()
    const time = clock.fake(START)

    const result = clock.until(() => new Promise<string>(() => {}), { within: '5s', every: '1s' })
    await time.advanceBy('5s')

    assert.isNull(await result)
    assert.equal(time.pendingDeadlines, 0)
  })

  test('throws the reason of a caller that aborts during an observation that ignores it', async ({
    assert,
  }) => {
    const clock = new Clock()
    const time = clock.fake(START)
    const controller = new AbortController()

    const result = clock.until(() => new Promise<string>(() => {}), {
      within: '1 minute',
      every: '1s',
      signal: controller.signal,
    })
    controller.abort(new Error('cancelled by caller'))

    await assert.rejects(() => result, 'cancelled by caller')
    assert.equal(time.pendingDeadlines, 0)
  })

  test('pauses at least 1ms, so every 0 lets the fake time move', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START)
    let observations = 0

    const result = clock.until(() => void observations++, { within: 10, every: 0 })
    await time.runAll(100)

    assert.isNull(await result)
    assert.equal(observations, 10)
    assert.equal(clock.monotonic(), 10)
  })

  test('drops a value or an error observed after the deadline passed', async ({ assert }) => {
    const clock = new Clock()
    const busy = (milliseconds: number) => {
      const start = clock.monotonic()
      while (clock.monotonic() - start < milliseconds);
    }

    const value = await clock.until(
      () => {
        busy(25)
        return 'late'
      },
      { within: 5, every: 1 },
    )
    const error = await clock.until(
      () => {
        busy(25)
        throw new Error('late')
      },
      { within: 5, every: 1 },
    )

    assert.isNull(value)
    assert.isNull(error)
  })

  test('a budget of 0 checks once, on the system time too', async ({ assert }) => {
    const clock = new Clock()

    assert.equal(await clock.until(() => 'ready', { within: 0, every: 1 }), 'ready')
    assert.isNull(await clock.until(() => undefined, { within: 0, every: 1 }))
    await assert.rejects(
      () =>
        clock.until(
          () => {
            throw new Error('down')
          },
          { within: 0, every: 1 },
        ),
      'down',
    )
  })

  test('rejects an invalid every before observing', async ({ assert }) => {
    const clock = new Clock()
    let observed = false

    await assert.rejects(
      () => clock.until(() => (observed = true), { within: '1s', every: -1 }),
      RangeError,
    )
    assert.isFalse(observed)
  })
})

test.group('FakeClock | Tenace timers', () => {
  test('runAll drains timers and detects loops', async ({ assert }) => {
    const { clock, time } = fakeClock()
    let count = 0
    void clock.wait(1_000_000).then(() => count++)
    await time.runAll()
    assert.equal(count, 1)
    assert.equal(clock.monotonic(), 1_000_000)

    const loop = (): void => void clock.wait(1).then(loop)
    loop()
    await assert.rejects(() => time.runAll(50), /more than 50 timers/)
  })

  test('timers of Infinity never fire, NaN delays fire right away', async ({ assert }) => {
    const { clock, time } = fakeClock()
    const fired: string[] = []
    void time.wait(Number.POSITIVE_INFINITY).then(() => fired.push('never'))
    void time.wait(Number.NaN).then(() => fired.push(`nan@${clock.monotonic()}`))

    await time.runAll()
    assert.deepEqual(fired, ['nan@0'])
    assert.equal(time.pendingTimers, 1)

    time.letTimePass()
    await time.advanceBy(10)
    assert.deepEqual(fired, ['nan@0'])
  })

  test('advanceBy rejects negative, NaN and infinite durations', async ({ assert }) => {
    const { clock, time } = fakeClock()
    await time.advanceBy('1.5s')

    await assert.rejects(() => time.advanceBy(-500), RangeError)
    await assert.rejects(() => time.advanceBy(Number.NaN), RangeError)
    await assert.rejects(() => time.advanceBy(Number.POSITIVE_INFINITY), RangeError)
    assert.equal(clock.monotonic(), 1500)
  })

  test('timers scheduled after a retry yields to the event loop fire too', async ({ assert }) => {
    const { clock, time } = fakeClock()
    const times: number[] = []
    let settled = false
    // 100 retries without delay make the retry yield, the 115th attempt waits 10ms again
    void Tenace.policy()
      .withRetry({ retries: 120, delay: attempt => (attempt === 1 || attempt === 115 ? 10 : 0) })
      .settle(
        () => {
          times.push(clock.monotonic())
          throw new Error('down')
        },
        { clock },
      )
      .then(() => (settled = true))

    await time.advanceBy(20)
    assert.isTrue(settled)
    assert.lengthOf(times, 121)
    assert.equal(times.at(-1), 20)
  })

  test('one fake of the shared clock drives timeouts, retries and circuit breakers', async ({
    assert,
  }) => {
    using time = sharedClock.fake(START)
    const breaker = new CircuitBreaker({ trip: { consecutive: 3 }, openFor: '1 minute' })
    const policy = Tenace.policy()
      .withTimeout('5s')
      .with(breaker)
      .withRetry({ retries: 2, delay: '10s', retryOn: ['TimeoutError'] })

    const settled = policy.settle(() => new Promise(() => {}))
    await time.advanceBy('35s') // three timeouts of 5s, two delays of 10s
    const result = await settled

    assert.instanceOf(!result.ok && result.error, TimeoutError)
    assert.equal(breaker.state, 'open')
    assert.equal(time.pendingTimers, 0)

    await time.advanceBy('1 minute')
    assert.equal(breaker.state, 'half-open')
  })
})

test.group('SystemClock', () => {
  test('chains delays beyond the timer limit and never schedules Infinity', async ({ assert }) => {
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
      const system = new SystemClock()
      let fired = 0
      void system.wait(Number.POSITIVE_INFINITY).then(() => fired++)
      const long = system.timeout(limit * 2 + 10)
      for (let i = 0; i < 3; i++) scheduled.at(-1)!.fire()
      assert.deepEqual(
        scheduled.map(timer => timer.ms),
        [limit, limit, 10],
      )
      assert.isTrue(long.signal.aborted)

      const disposed = system.timeout(limit + 1)
      scheduled.at(-1)!.fire()
      disposed[Symbol.dispose]()
      assert.deepEqual(cleared, [scheduled.at(-1)!.id])
      assert.isFalse(disposed.signal.aborted)
      await Promise.resolve()
      assert.equal(fired, 0)
    } finally {
      Object.assign(globalThis, native)
    }
  })
})

test.group('sleep', () => {
  test('resolves true once the delay elapsed', async ({ assert }) => {
    const { clock, time } = fakeClock()
    let settled: boolean | undefined
    void sleep(clock, 100).then(value => (settled = value))

    await time.advanceBy(99)
    assert.isUndefined(settled)
    await time.advanceBy(1)
    assert.isTrue(settled)
  })

  test('resolves false as soon as the signal aborts and clears its timer', async ({ assert }) => {
    const { clock, time } = fakeClock()
    const controller = new AbortController()
    const pending = sleep(clock, 1000, controller.signal)

    controller.abort()
    assert.isFalse(await pending)
    assert.equal(time.pendingTimers, 0)
  })

  test('resolves false immediately for an already aborted signal', async ({ assert }) => {
    const { clock, time } = fakeClock()
    assert.isFalse(await sleep(clock, 1000, AbortSignal.abort()))
    assert.equal(time.pendingTimers, 0)
  })

  test('Infinity only ends with the signal', async ({ assert }) => {
    const controller = new AbortController()
    const pending = sleep(new Clock(), Number.POSITIVE_INFINITY, controller.signal)
    controller.abort()
    assert.isFalse(await pending)
  })

  test('works on the system clock', async ({ assert }) => {
    const start = performance.now()
    assert.isTrue(await sleep(new Clock(), 20))
    assert.isAtLeast(performance.now() - start, 15)
  })
})
