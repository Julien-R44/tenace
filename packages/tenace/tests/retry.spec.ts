import { test } from '@japa/runner'

import { backoff } from '../src/backoff.ts'
import { TenaceError, TimeoutError, UnexpectedError } from '../src/errors.ts'
import { listener, type TenaceEvent } from '../src/instrumentation.ts'
import { sleep } from '../src/internal/sleep.ts'
import { err, ok } from '../src/result.ts'
import { Retry } from '../src/strategies/retry.ts'
import { RetryBudget } from '../src/strategies/retry_budget.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'
import { NotFound } from './helpers/strategies.ts'

class RateLimited extends TenaceError {
  readonly _tag = 'RateLimited' as const
  readonly code = 'E_RATE_LIMITED' as const
  readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super('rate limited')
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * A function failing `failures` times before succeeding, recording attempts and times.
 */
function flaky(failures: number, clock?: TestClock) {
  const calls: { attempt: number; at: number }[] = []
  const fn = ({ attempt }: { attempt: number }) => {
    calls.push({ attempt, at: clock?.now() ?? 0 })
    if (calls.length <= failures) throw new Error(`failure ${calls.length}`)
    return `success after ${calls.length}`
  }
  return { fn, calls }
}

test.group('Retry | attempts', () => {
  test('retries until success, the fn sees 1-based attempts', async ({ assert }) => {
    const { fn, calls } = flaky(2)
    const value = await Tenace.policy().withRetry({ retries: 3, delay: 0 }).execute(fn)
    assert.equal(value, 'success after 3')
    assert.deepEqual(
      calls.map(call => call.attempt),
      [1, 2, 3],
    )
  })

  test('returns the last error once retries are exhausted', async ({ assert }) => {
    const { fn, calls } = flaky(10)
    const result = await Tenace.policy().withRetry({ retries: 2, delay: 0 }).settle(fn)
    assert.lengthOf(calls, 3)
    assert.isTrue(!result.ok && result.error instanceof UnexpectedError)
    if (result.ok) return
    assert.equal((result.error.cause as Error).message, 'failure 3')
  })

  test('execute() rethrows the last raw error', async ({ assert }) => {
    const { fn } = flaky(10)
    await assert.rejects(
      () => Tenace.policy().withRetry({ retries: 1, delay: 0 }).execute(fn),
      'failure 2',
    )
  })

  test('retries: 0 runs a single attempt', async ({ assert }) => {
    const { fn, calls } = flaky(10)
    await Tenace.policy().withRetry({ retries: 0 }).settle(fn)
    assert.lengthOf(calls, 1)
  })

  test('does not retry successes, including ok() results', async ({ assert }) => {
    let calls = 0
    await Tenace.policy()
      .withRetry({ retries: 3, delay: 0 })
      .execute(() => ok(++calls))
    assert.equal(calls, 1)
  })

  test('retries err() results like throws', async ({ assert }) => {
    let calls = 0
    const result = await Tenace.policy()
      .withRetry({ retries: 2, delay: 0 })
      .settle(() => (++calls < 3 ? err(new NotFound('x')) : ok('found')))
    assert.deepEqual(result, ok('found'))
  })

  test('rejects invalid retries', ({ assert }) => {
    assert.throws(() => new Retry({ retries: -1 }), RangeError)
    assert.throws(() => new Retry({ retries: 1.5 }), RangeError)
    assert.doesNotThrow(() => new Retry({ retries: Number.POSITIVE_INFINITY }))
  })
})

test.group('Retry | classification', () => {
  test('retryOn only retries the listed tags', async ({ assert }) => {
    let calls = 0
    const policy = Tenace.policy<NotFound>().withRetry({
      retries: 5,
      delay: 0,
      retryOn: ['NotFound'],
    })

    await policy.settle(() => (++calls, err(new NotFound('x'))))
    assert.equal(calls, 6)

    calls = 0
    await policy.settle(() => {
      calls++
      throw new Error('not retried')
    })
    assert.equal(calls, 1)
  })

  test('retryIf decides with the error and the attempt', async ({ assert }) => {
    const seen: [string, number][] = []
    const { fn } = flaky(10)
    await Tenace.policy()
      .withRetry({
        retries: 5,
        delay: 0,
        retryIf: (error, attempt) => {
          seen.push([(error as UnexpectedError)._tag, attempt])
          return attempt < 2
        },
      })
      .settle(fn)
    assert.deepEqual(seen, [
      ['UnexpectedError', 1],
      ['UnexpectedError', 2],
    ])
  })

  test('retryOn and retryIf must both agree', async ({ assert }) => {
    let calls = 0
    await Tenace.policy<NotFound>()
      .withRetry({ retries: 5, delay: 0, retryOn: ['NotFound'], retryIf: () => false })
      .settle(() => (++calls, err(new NotFound('x'))))
    assert.equal(calls, 1)
  })

  test('a throwing retryIf is a bug: the execution rejects with the thrown value', async ({
    assert,
  }) => {
    const bug = new Error('bug')
    const { fn, calls } = flaky(10)
    const settled = Tenace.policy()
      .withRetry({
        retries: 5,
        retryIf: () => {
          throw bug
        },
      })
      .settle(fn)
    assert.strictEqual(await settled.catch((error: unknown) => error), bug)
    assert.lengthOf(calls, 1)
  })

  test('waits a fixed delay between attempts', async ({ assert }) => {
    const clock = new TestClock()
    const { fn, calls } = flaky(2, clock)
    const done = Tenace.policy().withRetry({ retries: 3, delay: '200ms' }).execute(fn, { clock })
    await clock.advance(1000)
    await done
    assert.deepEqual(
      calls.map(call => call.at),
      [0, 200, 400],
    )
  })

  test('a delay function receives the failed attempt and its error', async ({ assert }) => {
    const clock = new TestClock()
    const { fn, calls } = flaky(3, clock)
    const seen: [number, string][] = []
    const done = Tenace.policy()
      .withRetry({
        retries: 3,
        delay: (attempt, error) => {
          seen.push([attempt, (error as UnexpectedError).message])
          return attempt * 100
        },
      })
      .execute(fn, { clock })
    await clock.advance(1000)
    await done
    assert.deepEqual(seen, [
      [1, 'failure 1'],
      [2, 'failure 2'],
      [3, 'failure 3'],
    ])
    assert.deepEqual(
      calls.map(call => call.at),
      [0, 100, 300, 600],
    )
  })

  test('waits at least retryAfterMs when the error has one', async ({ assert }) => {
    const clock = new TestClock()
    const times: number[] = []
    const fn = () => {
      times.push(clock.now())
      return times.length === 1 ? err(new RateLimited(1000)) : ok('ok')
    }

    const done = Tenace.policy().withRetry({ retries: 1, delay: 10 }).execute(fn, { clock })
    await clock.advance(2000)
    await done
    assert.deepEqual(times, [0, 1000])

    times.length = 0
    const start = clock.now()
    const ignored = Tenace.policy()
      .withRetry({ retries: 1, delay: 10, respectRetryAfter: false })
      .execute(fn, { clock })
    await clock.advance(2000)
    await ignored
    assert.deepEqual(times, [start, start + 10])
  })

  test('maxDelay caps the delay, retryAfterMs included', async ({ assert }) => {
    const clock = new TestClock()
    const delays: number[] = []
    const done = Tenace.policy()
      .withRetry({
        retries: 2,
        delay: '1h',
        maxDelay: '1s',
        onRetry: event => delays.push(event.delayMs),
      })
      .settle(() => err(new RateLimited(3_000_000_000)), { clock })
    await clock.advance('2s')
    await done
    assert.deepEqual(delays, [1000, 1000])
  })

  test('an Infinity delay or retryAfterMs stops retrying', async ({ assert }) => {
    const declined: string[] = []
    let calls = 0
    const result = await Tenace.policy({
      instrumentation: listener(event => {
        if (event.type === 'retry.declined') declined.push(event.reason)
      }),
    })
      .withRetry({ retries: 3, delay: 0 })
      .settle(() => {
        calls++
        return err(new RateLimited(Number.POSITIVE_INFINITY))
      })
    assert.instanceOf(!result.ok && result.error, RateLimited)
    assert.equal(calls, 1)
    assert.deepEqual(declined, ['delay'])
  })

  test('onRetry is called before each wait', async ({ assert }) => {
    const events: [number, number][] = []
    const { fn } = flaky(2)
    await Tenace.policy()
      .withRetry({
        retries: 3,
        delay: 0,
        onRetry: event => events.push([event.attempt, event.delayMs]),
      })
      .execute(fn)
    assert.deepEqual(events, [
      [1, 0],
      [2, 0],
    ])
  })

  test('uses an exponential backoff with jitter by default', async ({ assert }) => {
    const clock = new TestClock()
    const { fn, calls } = flaky(3, clock)
    const done = Tenace.policy().withRetry({ retries: 3 }).execute(fn, { clock })
    await clock.advance(10_000)
    await done
    const [a, b, c, d] = calls.map(call => call.at) as [number, number, number, number]
    assert.isAtMost(b - a, 100)
    assert.isAtMost(c - b, 200)
    assert.isAtMost(d - c, 400)
  })
})

test.group('Retry | values', () => {
  /**
   * A function returning these statuses in turn, like fetch returning responses that did not throw.
   */
  function responses(...statuses: number[]) {
    let calls = 0
    const fn = () => ({ status: statuses[Math.min(calls++, statuses.length - 1)]! })
    return { fn, calls: () => calls }
  }

  test('retries values retryIfValue rejects, until one passes', async ({ assert }) => {
    const { fn, calls } = responses(503, 503, 200)
    const response = await Tenace.call(fn)
      .withRetry({ retries: 3, delay: 0, retryIfValue: res => res.status === 503 })
      .execute()
    assert.deepEqual(response, { status: 200 })
    assert.equal(calls(), 3)
  })

  test('returns the last value as a success once retries are exhausted', async ({ assert }) => {
    const events: TenaceEvent[] = []
    const { fn, calls } = responses(503)
    const result = await Tenace.call(fn, { instrumentation: listener(e => events.push(e)) })
      .withRetry({ retries: 2, delay: 0, retryIfValue: res => res.status === 503 })
      .settle()
    assert.deepEqual(result, ok({ status: 503 }))
    assert.equal(calls(), 3)
    assert.deepEqual(events.at(-1), {
      type: 'retry.exhausted',
      attempts: 3,
      value: { status: 503 },
    })
  })

  test('errors and values share one retry count, errors keep retryOn', async ({ assert }) => {
    const causes: string[] = []
    let calls = 0
    const fn = () => {
      calls++
      if (calls === 1) return err(new NotFound('x'))
      if (calls === 2) return { status: 503 }
      return { status: 200 }
    }
    const result = await Tenace.call(fn)
      .withRetry({
        retries: 1,
        delay: 0,
        retryOn: ['NotFound'],
        retryIfValue: res => res.status === 503,
        onRetry: event => causes.push('value' in event ? 'value' : 'error'),
      })
      .settle()
    // one retry only: the 503 of the second call is returned
    assert.deepEqual(result, ok({ status: 503 }))
    assert.deepEqual(causes, ['error'])
  })

  test('delay sees the cause, so a response can set the delay', async ({ assert }) => {
    const clock = new TestClock()
    const times: number[] = []
    let calls = 0
    const fn = () => {
      times.push(clock.now())
      return ++calls === 1 ? { status: 429, retryAfter: 2000 } : { status: 200, retryAfter: 0 }
    }
    const done = Tenace.call(fn)
      .withRetry({
        retries: 1,
        retryIfValue: res => res.status === 429,
        delay: (_attempt, cause) => ('value' in cause ? cause.value.retryAfter : 10),
      })
      .execute({ clock })
    await clock.advance('2s')
    assert.deepEqual(await done, { status: 200, retryAfter: 0 })
    assert.deepEqual(times, [0, 2000])
  })

  test('never retries a value when the call is not idempotent', async ({ assert }) => {
    const events: TenaceEvent[] = []
    const { fn, calls } = responses(503, 200)
    const result = await Tenace.call(fn, { instrumentation: listener(e => events.push(e)) })
      .withRetry({ retries: 2, delay: 0, retryIfValue: res => res.status === 503 })
      .settle({ idempotent: false })
    assert.deepEqual(result, ok({ status: 503 }))
    assert.equal(calls(), 1)
    assert.deepEqual(events, [
      { type: 'retry.declined', attempt: 1, reason: 'idempotency', value: { status: 503 } },
    ])
  })
})

test.group('Retry | abort', () => {
  test('stops waiting and retrying as soon as the caller aborts', async ({ assert }) => {
    const clock = new TestClock()
    const controller = new AbortController()
    const { fn, calls } = flaky(10, clock)
    const settled = Tenace.policy()
      .withRetry({ retries: 5, delay: '1s' })
      .settle(fn, { clock, signal: controller.signal })

    await clock.advance(500)
    controller.abort('stop')
    assert.equal(await settled.catch((error: unknown) => error), 'stop')
    await clock.advance(10_000)
    assert.lengthOf(calls, 1)
    assert.equal(clock.pendingTimers, 0)
  })

  test('a timeout inside the retry bounds each attempt', async ({ assert }) => {
    const clock = new TestClock()
    let calls = 0
    const settled = Tenace.policy()
      .withTimeout(100)
      .withRetry({ retries: 2, delay: 0, retryOn: ['TimeoutError'] })
      .settle(
        async ({ signal }) => {
          calls++
          await sleep(clock, 1000, signal)
          return 'never'
        },
        { clock },
      )
    await clock.advance(300)
    const result = await settled
    assert.equal(calls, 3)
    assert.isTrue(!result.ok && result.error instanceof TimeoutError)
  })

  test('a timeout outside the retry stops the retries when it fires', async ({ assert }) => {
    const clock = new TestClock()
    const { fn, calls } = flaky(10, clock)
    const settled = Tenace.policy()
      .withRetry({ retries: 10, delay: 100 })
      .withTimeout(250)
      .settle(fn, { clock })
    await clock.advance(5000)
    const result = await settled
    assert.isTrue(!result.ok && result.error instanceof TimeoutError)
    assert.deepEqual(
      calls.map(call => call.at),
      [0, 100, 200],
    )
  })
})

test.group('Retry | budget', () => {
  test('caps retries to a share of executions', async ({ assert }) => {
    const clock = new TestClock()
    const budget = new RetryBudget({ ratio: 0.5, minPerSecond: 0, clock })
    const policy = Tenace.policy().withRetry({ retries: 1, delay: 0, budget })

    const counts: number[] = []
    for (let i = 0; i < 4; i++) {
      const { fn, calls } = flaky(10)
      await policy.settle(fn, { clock })
      counts.push(calls.length)
    }
    assert.deepEqual(counts, [1, 2, 1, 2])
  })

  test('the window slides and minPerSecond allows retries without traffic', async ({ assert }) => {
    const clock = new TestClock()
    const budget = new RetryBudget({ ratio: 0, minPerSecond: 0.1, window: '10s', clock })

    assert.isTrue(budget.tryAcquire())
    assert.isFalse(budget.tryAcquire())
    await clock.advance(10_000)
    assert.isTrue(budget.tryAcquire())
  })

  test('uses the clock of the execution when it has none', async ({ assert }) => {
    const clock = new TestClock()
    const budget = new RetryBudget({ ratio: 0, minPerSecond: 0.1, window: '10s' })
    const policy = Tenace.policy().withRetry({ retries: 1, delay: 0, budget })
    const attempts = async () => {
      const { fn, calls } = flaky(10)
      await policy.settle(fn, { clock })
      return calls.length
    }

    assert.equal(await attempts(), 2)
    assert.equal(await attempts(), 1)
    await clock.advance('10s')
    assert.equal(await attempts(), 2)

    // a clock behind the one that started the window starts a new one
    const { fn, calls } = flaky(10)
    await policy.settle(fn, { clock: new TestClock() })
    assert.equal(calls.length, 2)
  })

  test('rejects invalid options', ({ assert }) => {
    assert.throws(() => new RetryBudget({ ratio: -1 }), RangeError)
    assert.throws(() => new RetryBudget({ window: 0 }), RangeError)
  })
})

test.group('backoff', () => {
  const half = () => 0.5

  test('exponential doubles from base, capped by max', ({ assert }) => {
    const delay = backoff.exponential({ base: 100, max: 500, jitter: 'none' })
    assert.deepEqual([1, 2, 3, 4, 5].map(delay), [100, 200, 400, 500, 500])
    assert.deepEqual(
      [1, 2, 3].map(backoff.exponential({ base: '1s', factor: 3, jitter: 'none' })),
      [1000, 3000, 9000],
    )
  })

  test('jitter spreads the delay', ({ assert }) => {
    assert.equal(backoff.exponential({ base: 100, random: half })(2), 100)
    assert.equal(backoff.exponential({ base: 100, jitter: 'equal', random: half })(2), 150)
    assert.equal(backoff.exponential({ base: 100, random: () => 0 })(3), 0)
  })

  test('linear and constant', ({ assert }) => {
    assert.deepEqual([1, 2, 3].map(backoff.linear({ base: 50, max: 120 })), [50, 100, 120])
    assert.deepEqual([1, 5].map(backoff.constant('2s')), [2000, 2000])
  })

  test('never computes NaN for extreme options', ({ assert }) => {
    assert.equal(backoff.exponential({ base: 0, jitter: 'none' })(1100), 0)
    assert.equal(backoff.exponential({ max: Infinity, random: () => 0 })(1100), Infinity)
    assert.equal(backoff.linear({ base: Infinity, max: Infinity, jitter: 'full' })(1), Infinity)
  })

  test('rejects invalid options', ({ assert }) => {
    assert.throws(() => backoff.exponential({ factor: 0.5 }), RangeError)
    assert.throws(() => backoff.exponential({ factor: Infinity }), RangeError)
    assert.throws(() => backoff.constant(-1), RangeError)
  })
})
