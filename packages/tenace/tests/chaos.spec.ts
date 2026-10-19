import { test } from '@japa/runner'

import { ChaosError, TenaceError, UnexpectedError } from '../src/errors.ts'
import { listener, type TenaceEvent } from '../src/instrumentation.ts'
import { err, ok } from '../src/result.ts'
import { Chaos } from '../src/strategies/chaos.ts'
import { CircuitBreaker } from '../src/strategies/circuit_breaker/circuit_breaker.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'

class Injected extends TenaceError {
  readonly _tag = 'Injected' as const
  readonly code = 'E_INJECTED' as const
}

test.group('Chaos', () => {
  test('injects a ChaosError throw by default, without calling fn', async ({ assert }) => {
    let called = false
    const result = await Tenace.policy()
      .withChaos()
      .settle(() => (called = true))
    assert.isFalse(called)
    assert.isTrue(!result.ok && result.error instanceof UnexpectedError)
    assert.instanceOf((result as { error: UnexpectedError }).error.cause, ChaosError)
  })

  test('injects typed errors, values and custom throws', async ({ assert }) => {
    const injected = new Injected('x')
    assert.deepEqual(
      await Tenace.policy()
        .withChaos({ error: () => injected })
        .settle(() => 1),
      err(injected),
    )
    assert.deepEqual(
      await Tenace.policy()
        .withChaos({ value: () => 'canned' })
        .settle(() => 1),
      ok('canned'),
    )
    const boom = new Error('boom')
    await assert.rejects(
      () =>
        Tenace.policy()
          .withChaos({ throws: () => boom })
          .execute(() => 1),
      'boom',
    )
  })

  test('a throwing factory simulates a throw of the function', async ({ assert }) => {
    const boom = new Error('boom')
    let fallbackError: unknown
    const result = await Tenace.policy()
      .withChaos({
        throws: () => {
          throw boom
        },
      })
      .withFallback(error => (fallbackError = error))
      .settle(() => 1)
    assert.isTrue(result.ok)
    assert.instanceOf(fallbackError, UnexpectedError)
    assert.strictEqual((fallbackError as UnexpectedError).cause, boom)
  })

  test('adds latency, then calls fn', async ({ assert }) => {
    const clock = new TestClock()
    const done = Tenace.policy()
      .withChaos({ latency: '1s' })
      .execute(() => clock.now(), { clock })
    await clock.advance(1000)
    assert.equal(await done, 1000)
  })

  test('latency combined with a timeout produces timeouts', async ({ assert }) => {
    const clock = new TestClock()
    const done = Tenace.policy()
      .withChaos({ latency: '2s' })
      .withTimeout('1s')
      .settle(() => 'never', { clock })
    await clock.advance(1000)
    const result = await done
    assert.isTrue(!result.ok && (result.error as { _tag?: string })._tag === 'TimeoutError')
  })

  test('rate and enabled select the affected calls', async ({ assert }) => {
    const draws = [0.1, 0.9, 0.29, 0.3]
    const policy = Tenace.policy().withChaos({
      rate: 0.3,
      value: () => 'chaos',
      random: () => draws.shift()!,
    })
    const values: unknown[] = []
    for (let i = 0; i < 4; i++) values.push(await policy.execute(() => 'real'))
    assert.deepEqual(values, ['chaos', 'real', 'chaos', 'real'])

    let enabled = false
    const gated = Tenace.policy().withChaos({ value: () => 'chaos', enabled: () => enabled })
    assert.equal(await gated.execute(() => 'real'), 'real')
    enabled = true
    assert.equal(await gated.execute(() => 'real'), 'chaos')
  })

  test('rejects invalid rates', ({ assert }) => {
    assert.throws(() => new Chaos({ rate: 1.5 }), RangeError)
  })

  test('Tenace.chaos injects faults around every call until restored', async ({ assert }) => {
    const restore = Tenace.chaos({ throws: () => new Error('global chaos') })
    try {
      await assert.rejects(() => Tenace.policy().execute(() => 1), 'global chaos')
      // retries see the injected failure like a real one
      let calls = 0
      const result = await Tenace.policy()
        .withRetry({ retries: 2, delay: 0 })
        .settle(() => ++calls)
      assert.isFalse(result.ok)
      assert.equal(calls, 0)
    } finally {
      restore()
    }
    assert.equal(await Tenace.policy().execute(() => 1), 1)
  })
})

test.group('Idempotency', () => {
  test('non idempotent executions are not retried after running', async ({ assert }) => {
    const events: TenaceEvent[] = []
    let calls = 0
    const result = await Tenace.policy({ instrumentation: listener(event => events.push(event)) })
      .withRetry({ retries: 3, delay: 0 })
      .settle(
        () => {
          calls++
          throw new Error('payment failed')
        },
        { idempotent: false },
      )
    assert.isFalse(result.ok)
    assert.equal(calls, 1)
    assert.deepEqual(
      events.map(event => event.type === 'retry.declined' && event.reason),
      ['idempotency'],
    )
  })

  test('errors that are not retryable are not declined for idempotency', async ({ assert }) => {
    const events: TenaceEvent[] = []
    await Tenace.policy({ instrumentation: listener(event => events.push(event)) })
      .withRetry({ retries: 3, delay: 0, retryIf: () => false })
      .settle(() => err('fatal'), { idempotent: false })
    assert.notInclude(
      events.map(event => event.type),
      'retry.declined',
    )
  })

  test('calls rejected before running are still retried', async ({ assert }) => {
    const clock = new TestClock()
    const breaker = new CircuitBreaker({ trip: { consecutive: 1 }, openFor: 100, clock })
    const policy = Tenace.policy().with(breaker).withRetry({ retries: 1, delay: 0 })
    await policy.settle(() => err('down'), { clock })

    let calls = 0
    const settled = policy.settle(() => ++calls, { clock, idempotent: false })
    await clock.advance(100)
    assert.deepEqual(await settled, ok(1))

    const strict = Tenace.policy()
      .with(breaker)
      .withRetry({ retries: 1, delay: 0, idempotent: false })
    // the failure itself is not retried, the rejection by the open circuit is
    let strictCalls = 0
    const failed = await strict.settle(() => (strictCalls++, err('down')), { clock })
    assert.deepEqual(failed, err('down'))
    assert.equal(strictCalls, 1)
    const retried = strict.settle(() => 'x', { clock })
    await clock.advance(100)
    assert.deepEqual(await retried, ok('x'))
  })

  test('the retry option overrides the execution option', async ({ assert }) => {
    let calls = 0
    await Tenace.policy()
      .withRetry({ retries: 2, delay: 0, idempotent: true })
      .settle(() => (calls++, err('x')), { idempotent: false })
    assert.equal(calls, 3)
  })
})
