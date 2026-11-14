import { test } from '@japa/runner'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import { clock as sharedClock, Clock } from '../src/clock/clock.ts'
import { SystemClock } from '../src/clock/system_clock.ts'
import type { PollOptions } from '../src/clock/types.ts'
import { CancelledError, TimeoutError, UnexpectedError } from '../src/errors.ts'
import { sleep } from '../src/internal/sleep.ts'
import { Result } from '../src/result/namespace.ts'
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

  test('disposing an old fake does not replace the current fake', async ({ assert }) => {
    const clock = new Clock()
    const first = clock.fake(START)
    clock.restore()

    using second = clock.fake(new Date('2030-06-01T00:00:00Z'))
    first[Symbol.dispose]()

    assert.equal(clock.now().toString(), '2030-06-01T00:00:00Z')
    await second.advanceBy(7)
    assert.equal(clock.monotonic(), 7)
  })

  test('restoring stops the automatic driver and abandons pending timers', async ({ assert }) => {
    const clock = new Clock()
    const time = clock.fake(START).letTimePass()
    let woke = false
    const deadline = clock.timeout(5)
    void clock.wait(10).then(() => (woke = true))

    clock.restore()
    await setImmediate()
    await setImmediate()

    assert.isFalse(woke)
    assert.isFalse(deadline.signal.aborted)
    assert.equal(time.monotonic(), 0)
    assert.equal(time.pendingTimers, 0)
  })

  test('refuses manual advancement in automatic mode', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START).letTimePass()
    const readings: number[] = []
    const wait = clock.wait(100).then(() => readings.push(clock.monotonic()))

    await assert.rejects(() => time.advanceBy(10), /automatic/)
    await assert.rejects(() => time.runAll(), /automatic/)
    await wait

    assert.deepEqual(readings, [100])
    assert.equal(clock.monotonic(), 100)
  })

  test('refuses nested fakes and overlapping drivers without changing the active clock', async ({
    assert,
  }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    assert.throws(() => clock.fake(new Date(0)), /already faked/)
    assert.equal(clock.now().toString(), '2026-01-01T10:00:00Z')

    const advancing = time.advanceBy(100)
    const overlapping = time.advanceBy(10)
    const draining = time.runAll()
    assert.throws(() => time.letTimePass(), /already being advanced/)
    await assert.rejects(() => overlapping, /already being advanced/)
    await assert.rejects(() => draining, /already being advanced/)
    await advancing
    assert.equal(clock.monotonic(), 100)

    const stopped = time.advanceBy(50)
    clock.restore()
    await stopped
    assert.equal(time.monotonic(), 100)
    await assert.rejects(() => time.advanceBy(1), /disposed/)
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

  test('ref: false lets the process exit while only its timers are pending', async ({ assert }) => {
    const index = new URL('../src/index.ts', import.meta.url).href
    // one pending timer of each kind, an hour away: a wait, a deadline, the deadline and
    // the pause of waitFor, and a policy whose timeout and retry delay are both pending
    const script = (ref: string): string => `
      import { clock, Tenace } from '${index}'
      const options = ${ref}
      void clock.wait('1h', options)
      clock.timeout('1h', options)
      void clock.waitFor(() => false, { timeout: '1h', interval: '30min', ...options })
      void Tenace.policy()
        .withTimeout('1h')
        .withRetry({ retries: 1, delay: '1h' })
        .settle(({ attempt }) => attempt > 1 ? new Promise(() => {}) : Promise.reject(1), options)
    `
    // the second stays up until killed
    const exits = await Promise.all(
      ['{ ref: false }', '{}'].map(
        ref =>
          new Promise<string>(resolve => {
            execFile(
              process.execPath,
              [...process.execArgv, '--input-type=module', '-e', script(ref)],
              { timeout: 1500 },
              (error, _stdout, stderr) =>
                resolve(error ? (error.killed ? 'killed' : `failed: ${stderr}`) : 'exited'),
            )
          }),
      ),
    )

    assert.deepEqual(exits, ['exited', 'killed'])
  }).timeout(5000)
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

    const wait = clock.wait(1000, { signal: controller.signal })
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

test.group('Clock | waitFor and poll', () => {
  test('waitFor unwraps booleans and uses the default interval', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START).letTimePass()
    const observedAt: number[] = []
    const attempts: number[] = []
    let lastSignal: AbortSignal | undefined

    const result = await clock.waitFor(async ({ signal, attempt }) => {
      lastSignal = signal
      attempts.push(attempt)
      observedAt.push(clock.monotonic())
      return Result.ok(attempt === 3)
    })

    assert.isTrue(result.ok)
    assert.isUndefined(Result.unwrap(result))
    assert.deepEqual(observedAt, [0, 100, 200])
    assert.deepEqual(attempts, [1, 2, 3])
    assert.isTrue(lastSignal!.aborted)
    assert.equal(time.pendingTimers, 0)
  })

  test('waitFor stays strict when reusing poll options', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START).letTimePass()
    const options: PollOptions<boolean> = {
      timeout: 10,
      timeoutMode: 'finish-current',
      until: value => value,
    }

    const result = await clock.waitFor(async ({ signal }) => {
      await clock.wait(20, { signal })
      return true
    }, options)

    assert.equal(Result.unwrapErr(result, 'TimeoutError').timeoutMs, 10)
    assert.equal(clock.monotonic(), 10)
    assert.equal(time.pendingTimers, 0)
  })

  test('poll returns the unwrapped accepted observation without overlapping calls', async ({
    assert,
  }) => {
    const clock = new Clock()
    using time = clock.fake(START).letTimePass()
    const observedAt: number[] = []
    let active = 0

    const result = await clock.poll(
      async ({ signal, attempt }) => {
        assert.equal(active++, 0)
        observedAt.push(clock.monotonic())
        await clock.wait(3, { signal })
        return Result.ok({ id: 'job-7', done: attempt === 3 })
      },
      {
        until: async job => {
          await clock.wait(2)
          active--
          return job.done
        },
        timeout: 100,
        interval: 10,
      },
    )

    assert.deepEqual(Result.unwrap(result), { id: 'job-7', done: true })
    assert.deepEqual(observedAt, [0, 15, 30])
    assert.equal(clock.monotonic(), 35)
    assert.equal(time.pendingTimers, 0)
  })

  test('finish-current keeps a late accepted observation and lets its predicate finish', async ({
    assert,
  }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    const caller = new AbortController()
    const authorization = { id: 'auth-7', status: 'valid' }
    const accepted = Result.ok(authorization)
    const observedAt: number[] = []
    let observedSignal: AbortSignal | undefined
    let settled = false

    const pending = clock.poll(
      async ({ signal, attempt }) => {
        observedSignal = signal
        observedAt.push(clock.monotonic())
        if (attempt === 1) return Result.ok({ id: 'auth-7', status: 'pending' })
        await clock.wait('3s', { signal })
        return accepted
      },
      {
        until: async value => {
          if (value.status === 'pending') return false
          await clock.wait('1s')
          return true
        },
        interval: '59s',
        timeout: '60s',
        timeoutMode: 'finish-current',
        signal: caller.signal,
      },
    )
    void pending.then(() => (settled = true))

    await time.advanceBy('60s')
    assert.isFalse(settled)
    assert.isFalse(observedSignal!.aborted)
    await time.advanceBy('3s')

    assert.strictEqual(await pending, accepted)
    assert.strictEqual(Result.unwrap(await pending), authorization)
    assert.deepEqual(observedAt, [0, 59_000])
    assert.equal(clock.monotonic(), 63_000)
    assert.isFalse(observedSignal!.aborted)
    assert.equal(time.pendingTimers, 0)

    caller.abort('resource closed')
    assert.equal(observedSignal!.reason, 'resource closed')
  })

  test('finish-current times out without another observation, during or after a pause', async ({
    assert,
  }) => {
    for (const duration of [3, 15]) {
      const clock = new Clock()
      using time = clock.fake(START).letTimePass()
      let observations = 0
      let observedSignal: AbortSignal | undefined

      const result = await clock.poll(
        async ({ signal }) => {
          observations++
          observedSignal = signal
          await clock.wait(duration, { signal })
          return 'pending'
        },
        { until: () => false, timeout: 10, interval: 20, timeoutMode: 'finish-current' },
      )

      assert.equal(Result.unwrapErr(result, 'TimeoutError').timeoutMs, 10)
      assert.equal(observations, 1)
      assert.equal(clock.monotonic(), Math.max(duration, 10))
      assert.isTrue(observedSignal!.aborted)
      assert.equal(time.pendingTimers, 0)
    }
  })

  test('finish-current preserves late business errors and captures late exceptions', async ({
    assert,
  }) => {
    for (const source of ['business', 'observation', 'predicate']) {
      const clock = new Clock()
      using time = clock.fake(START).letTimePass()
      const cause = new Error('authorization unavailable')
      const failed = Result.err({ _tag: 'AuthorizationGone', id: 'auth-7' })

      const result = await clock.poll(
        async ({ signal }) => {
          if (source === 'predicate') return Result.ok('ready')
          await clock.wait(15, { signal })
          if (source === 'observation') throw cause
          return failed
        },
        {
          until: async () => {
            await clock.wait(15)
            throw cause
          },
          timeout: 10,
          timeoutMode: 'finish-current',
        },
      )

      if (source === 'business') assert.strictEqual(result, failed)
      else assert.strictEqual(Result.unwrapErr(result, 'UnexpectedError').cause, cause)
      assert.equal(time.pendingTimers, 0)
    }
  })

  test('finish-current still cancels a stalled observation or predicate after the deadline', async ({
    assert,
  }) => {
    for (const source of ['observation', 'predicate']) {
      const clock = new Clock()
      using time = clock.fake(START)
      const caller = new AbortController()
      const late = Promise.withResolvers<string>()
      let observedSignal: AbortSignal | undefined
      let settled = false
      const pending = clock.poll(
        ({ signal }) => {
          observedSignal = signal
          return source === 'observation' ? late.promise : 'ready'
        },
        {
          until: () => late.promise.then(() => true),
          timeout: 10,
          timeoutMode: 'finish-current',
          signal: caller.signal,
        },
      )
      void pending.then(() => (settled = true))

      await time.advanceBy(15)
      assert.isFalse(settled)
      assert.isFalse(observedSignal!.aborted)
      caller.abort('caller stopped polling')

      assert.equal(
        Result.unwrapErr(await pending, 'CancelledError').cause,
        'caller stopped polling',
      )
      assert.equal(observedSignal!.reason, 'caller stopped polling')
      assert.equal(time.pendingTimers, 0)
      late.reject(new Error('late rejection after cancellation'))
      await setImmediate()
    }
  })

  test('finish-current permits one asynchronous observation with a zero budget', async ({
    assert,
  }) => {
    const clock = new Clock()
    using time = clock.fake(START).letTimePass()
    const result = await clock.poll(
      async ({ signal }) => {
        await clock.wait(15, { signal })
        return 0
      },
      { until: value => value === 0, timeout: 0, timeoutMode: 'finish-current' },
    )

    assert.equal(Result.unwrap(result), 0)
    assert.equal(clock.monotonic(), 15)
    assert.equal(time.pendingTimers, 0)
  })

  test('poll treats falsy and nullable values as data, not sentinels', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START).letTimePass()

    for (const value of [0, false, null, undefined]) {
      const result = await clock.poll(({ attempt }) => (attempt === 2 ? value : 'pending'), {
        until: observed => observed === value,
        interval: 7,
      })
      assert.isTrue(result.ok)
      assert.strictEqual(Result.unwrap(result), value)
    }
    assert.equal(clock.monotonic(), 28)
    assert.equal(time.pendingTimers, 0)
  })

  test('both methods preserve a business error and stop without retrying', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    const failed = Result.err({ _tag: 'DeploymentGone', id: 'deploy-7' })
    let observations = 0
    const signals: AbortSignal[] = []
    const observe = ({ signal }: { signal: AbortSignal }) => {
      observations++
      signals.push(signal)
      return failed
    }

    assert.strictEqual(await clock.waitFor(observe), failed)
    assert.strictEqual(await clock.poll(observe, { until: () => true }), failed)
    assert.equal(observations, 2)
    assert.isTrue(signals.every(signal => signal.aborted))
    assert.equal(time.pendingTimers, 0)
  })

  test('returns TimeoutError with a last wait cut to the deadline', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START).letTimePass()
    const observedAt: number[] = []

    const result = await clock.waitFor(
      async () => {
        observedAt.push(clock.monotonic())
        return false
      },
      { timeout: 25_000, interval: 10_000 },
    )

    assert.equal(Result.unwrapErr(result, 'TimeoutError').timeoutMs, 25_000)
    assert.deepEqual(observedAt, [0, 10_000, 20_000])
    assert.equal(clock.monotonic(), 25_000)
    assert.equal(time.pendingTimers, 0)
  })

  test('uses the default timeout of 10 seconds', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START).letTimePass()
    const result = await clock.poll(() => 0, { until: value => value === 1 })

    assert.equal(Result.unwrapErr(result, 'TimeoutError').timeoutMs, 10_000)
    assert.equal(clock.monotonic(), 10_000)
    assert.equal(time.pendingTimers, 0)
  })

  test('drops values resolved by the abort at the deadline', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START)

    const result = clock.poll(
      ({ signal }) =>
        new Promise<string>(resolve => {
          signal.addEventListener('abort', () => resolve('too late'))
        }),
      { until: () => true, timeout: '5s', interval: '1s' },
    )
    await time.advanceBy('5s')

    assert.equal(Result.unwrapErr(await result, 'TimeoutError').timeoutMs, 5000)
    assert.equal(time.pendingTimers, 0)
  })

  test('cancellation while waiting returns CancelledError and its original cause', async ({
    assert,
  }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    const controller = new AbortController()
    const cause = new Error('cancelled by caller')

    const result = clock.waitFor(async () => false, {
      timeout: '1 minute',
      interval: '1s',
      signal: controller.signal,
    })
    await time.advanceBy('2s')
    controller.abort(cause)

    const error = Result.unwrapErr(await result, 'CancelledError')
    assert.instanceOf(error, CancelledError)
    assert.strictEqual(error.cause, cause)
    assert.equal(time.pendingTimers, 0)
  })

  test('an already aborted signal skips both observations', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    const signal = AbortSignal.abort('stopped')
    let called = false
    const observe = () => (called = true)

    const results = [
      await clock.waitFor(observe, { signal }),
      await clock.poll(observe, { signal, until: () => true }),
    ]
    for (const result of results) {
      assert.equal(Result.unwrapErr(result, 'CancelledError').cause, 'stopped')
    }
    assert.isFalse(called)
    assert.equal(time.pendingTimers, 0)
  })

  test('interval accepts a backoff of the number of observations', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START).letTimePass()
    const observedAt: number[] = []

    const result = await clock.waitFor(
      () => {
        observedAt.push(clock.monotonic())
        return observedAt.length === 4
      },
      { timeout: '1 minute', interval: backoff.exponential({ base: '1s', jitter: 'none' }) },
    )

    assert.isTrue(result.ok)
    assert.deepEqual(observedAt, [0, 1000, 3000, 7000])
    assert.equal(time.pendingTimers, 0)
  })

  test('bounds observations and predicates that ignore cancellation and consumes late rejections', async ({
    assert,
  }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    const late = Promise.withResolvers<boolean>()
    let signal: AbortSignal | undefined

    const result = clock.waitFor(
      context => {
        signal = context.signal
        return late.promise
      },
      { timeout: '5s' },
    )
    await time.advanceBy('5s')

    assert.equal(Result.unwrapErr(await result, 'TimeoutError').timeoutMs, 5000)
    assert.isTrue(signal!.aborted)
    assert.equal(time.pendingTimers, 0)
    late.reject(new Error('arrived after timeout'))
    await setImmediate()

    const predicate = Promise.withResolvers<boolean>()
    const polled = clock.poll(() => 7, {
      until: () => predicate.promise,
      timeout: 25,
      timeoutMode: 'strict',
    })
    await time.advanceBy(25)

    assert.equal(Result.unwrapErr(await polled, 'TimeoutError').timeoutMs, 25)
    assert.equal(time.pendingTimers, 0)
    predicate.reject(new Error('predicate failed after timeout'))
    await setImmediate()
  })

  test('cancels an observation that ignores its signal, even with an infinite timeout', async ({
    assert,
  }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    const controller = new AbortController()

    const result = clock.poll(() => new Promise<string>(() => {}), {
      until: () => true,
      timeout: Infinity,
      signal: controller.signal,
    })
    controller.abort('cancelled by caller')

    assert.equal(Result.unwrapErr(await result, 'CancelledError').cause, 'cancelled by caller')
    assert.equal(time.pendingTimers, 0)
  })

  test('pauses at least 1ms, so interval 0 lets the fake time move', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    let observations = 0

    const result = clock.waitFor(() => (++observations, false), { timeout: 10, interval: 0 })
    await time.runAll(100)

    assert.equal(Result.unwrapErr(await result, 'TimeoutError').timeoutMs, 10)
    assert.equal(observations, 10)
    assert.equal(clock.monotonic(), 10)
  })

  test('drops a value or an error observed after the deadline passed', async ({ assert }) => {
    const clock = new Clock()
    const busy = (milliseconds: number) => {
      const start = clock.monotonic()
      while (clock.monotonic() - start < milliseconds);
    }

    const value = await clock.poll(
      () => {
        busy(25)
        return 'late'
      },
      { until: () => true, timeout: 5 },
    )
    const error = await clock.waitFor(
      () => {
        busy(25)
        throw new Error('late')
      },
      { timeout: 5 },
    )

    assert.instanceOf(Result.unwrapErr(value), TimeoutError)
    assert.instanceOf(Result.unwrapErr(error), TimeoutError)
  })

  test('a budget of 0 checks once, on the system time too', async ({ assert }) => {
    const clock = new Clock()

    assert.isTrue((await clock.waitFor(() => true, { timeout: 0 })).ok)
    assert.instanceOf(
      Result.unwrapErr(await clock.waitFor(() => false, { timeout: 0 })),
      TimeoutError,
    )
    assert.isUndefined(
      Result.unwrap(await clock.poll(() => undefined, { until: () => true, timeout: 0 })),
    )
    const error = await clock.waitFor(
      () => {
        throw new Error('down')
      },
      { timeout: 0 },
    )
    assert.equal(Result.unwrapErr(error, 'UnexpectedError').cause instanceof Error, true)
  })

  test('wraps thrown, rejected and predicate errors without changing their cause', async ({
    assert,
  }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    const cause = new TypeError('invalid health response')
    const results = [
      await clock.waitFor(() => {
        throw cause
      }),
      await clock.poll(() => Promise.reject(cause), { until: () => true }),
      await clock.poll(() => 7, {
        until: () => {
          throw cause
        },
      }),
      await clock.poll(() => 7, {
        until: async () => {
          throw cause
        },
      }),
      await clock.waitFor(async () => {
        throw cause
      }),
    ]

    for (const result of results) {
      assert.strictEqual(Result.unwrapErr(result, 'UnexpectedError').cause, cause)
    }
    assert.equal(time.pendingTimers, 0)
  })

  test('argument validation returns UnexpectedError before observing', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    let observed = false
    const observe = () => (observed = true)
    const results = [
      await clock.waitFor(observe, { timeout: -1 }),
      await clock.poll(observe, { until: () => true, interval: 'invalid' }),
      await clock.waitFor(observe, { interval: -1 }),
      await clock.poll(observe, {} as never),
      await clock.poll(observe, { until: () => true, timeoutMode: 'cooperative' as never }),
    ]

    for (const result of results) {
      const error = Result.unwrapErr(result, 'UnexpectedError')
      assert.instanceOf(error.cause, Error)
    }
    assert.isFalse(observed)
    assert.equal(time.pendingTimers, 0)

    const invalidCondition = await clock.waitFor((() => 'not a boolean') as never)
    assert.instanceOf(Result.unwrapErr(invalidCondition), UnexpectedError)
    const invalidBackoff = await clock.waitFor(() => false, { interval: () => -1 })
    assert.instanceOf(Result.unwrapErr(invalidBackoff, 'UnexpectedError').cause, RangeError)
    assert.equal(time.pendingTimers, 0)
  })

  test('poll preserves a Response body and the caller link after success', async ({ assert }) => {
    const clock = new Clock()
    using time = clock.fake(START)
    const caller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const server = createServer((request, response) => {
      response.writeHead(200)
      if (request.url === '/complete') response.end('ready')
      else response.write('pending')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    try {
      const result = await clock.poll(
        ({ signal }) => {
          observedSignal = signal
          return fetch(`${origin}/complete`, { signal })
        },
        { until: response => response.ok, signal: caller.signal },
      )

      assert.isFalse(observedSignal!.aborted)
      assert.equal(await Result.unwrap(result).text(), 'ready')
      assert.equal(time.pendingTimers, 0)

      const pendingBody = await clock.poll(({ signal }) => fetch(`${origin}/stream`, { signal }), {
        until: response => response.ok,
        signal: caller.signal,
      })
      caller.abort(new Error('caller stopped reading'))
      assert.strictEqual(observedSignal!.reason, caller.signal.reason)
      await assert.rejects(() => Result.unwrap(pendingBody).text())
      assert.equal(time.pendingTimers, 0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      )
    }
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
    await setImmediate()
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
