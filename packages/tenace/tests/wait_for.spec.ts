import { test } from '@japa/runner'

import { TimeoutError } from '../src/errors.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'
import { waitFor } from '../src/wait_for.ts'

test.group('waitFor', () => {
  test('checks right away, then after each interval, until the condition is true', async ({
    assert,
  }) => {
    const clock = new TestClock()
    const checks: number[] = []
    const done = waitFor(
      ({ attempt }) => {
        checks.push(clock.now())
        return attempt === 3
      },
      { interval: '100ms', clock },
    )

    await clock.advance('1s')
    await done
    assert.deepEqual(checks, [0, 100, 200])
    assert.equal(clock.pendingTimers, 0)
  })

  test('an interval function receives the number of checks done', async ({ assert }) => {
    const clock = new TestClock()
    const checks: number[] = []
    const attempts: number[] = []
    const done = waitFor(
      async () => {
        checks.push(clock.now())
        return checks.length === 4
      },
      {
        interval: attempt => {
          attempts.push(attempt)
          return attempt * 100
        },
        clock,
      },
    )

    await clock.advance('1s')
    await done
    assert.deepEqual(attempts, [1, 2, 3])
    assert.deepEqual(checks, [0, 100, 300, 600])
  })

  test('rejects with a TimeoutError at the deadline, even during a check', async ({ assert }) => {
    const clock = new TestClock()
    let checkSignal: AbortSignal | undefined
    const done = waitFor(
      ({ signal, attempt }) => {
        checkSignal = signal
        return attempt === 1 ? false : new Promise<boolean>(() => {})
      },
      { interval: '400ms', timeout: '1s', clock },
    ).catch((error: unknown) => error)

    await clock.advance('999ms')
    assert.isFalse(checkSignal!.aborted)
    await clock.advance('1ms')

    const error = await done
    assert.instanceOf(error, TimeoutError)
    assert.equal((error as TimeoutError).timeoutMs, 1000)
    assert.isTrue(checkSignal!.aborted)
    assert.strictEqual(checkSignal!.reason, error)
    assert.equal(clock.pendingTimers, 0)
  })

  test('rejects with the abort reason and stops checking', async ({ assert }) => {
    const clock = new TestClock()
    const controller = new AbortController()
    let calls = 0
    const done = waitFor(() => (calls++, false), {
      interval: '100ms',
      timeout: Number.POSITIVE_INFINITY,
      signal: controller.signal,
      clock,
    }).catch((error: unknown) => error)

    await clock.advance('150ms')
    const reason = new Error('stop')
    controller.abort(reason)
    assert.strictEqual(await done, reason)

    await clock.advance('1s')
    assert.equal(calls, 2)
    assert.equal(clock.pendingTimers, 0)
  })

  test('does not check when the signal is already aborted', async ({ assert }) => {
    const reason = new Error('aborted')
    let called = false
    const error = await waitFor(() => (called = true), {
      signal: AbortSignal.abort(reason),
    }).catch((caught: unknown) => caught)

    assert.strictEqual(error, reason)
    assert.isFalse(called)
  })

  test('rejects with the error of the condition', async ({ assert }) => {
    const clock = new TestClock()
    const boom = new Error('boom')
    const done = waitFor(
      ({ attempt }) => {
        if (attempt === 2) throw boom
        return false
      },
      { clock },
    ).catch((error: unknown) => error)

    await clock.advance('1s')
    assert.strictEqual(await done, boom)
    assert.equal(clock.pendingTimers, 0)
  })

  test('a condition throwing undefined rejects', async ({ assert }) => {
    const outcome = await waitFor(() => {
      throw undefined
    }).then(
      () => 'resolved',
      () => 'rejected',
    )
    assert.equal(outcome, 'rejected')
  })

  test('rejects with a TypeError when the condition returns a non boolean', async ({ assert }) => {
    const error = await waitFor(() => 'yes' as never).catch((caught: unknown) => caught)
    assert.instanceOf(error, TypeError)
  })

  test('rejects invalid options instead of throwing', async ({ assert }) => {
    const pending = waitFor(() => true, { timeout: '-1s' as never })
    assert.instanceOf(await pending.catch((error: unknown) => error), RangeError)

    const badInterval = waitFor(() => true, { interval: 'soon' as never })
    assert.instanceOf(await badInterval.catch((error: unknown) => error), RangeError)
  })

  test('is exposed as Tenace.waitFor', ({ assert }) => {
    assert.strictEqual(Tenace.waitFor, waitFor)
  })
})
