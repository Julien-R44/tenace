import { test } from '@japa/runner'

import { TimeoutError, UnexpectedError } from '../src/errors.ts'
import { err, ok } from '../src/result/core.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'
import { BoomError, Explode, NotFound } from './helpers/strategies.ts'

const fail = () => {
  throw new Error('down')
}

test.group('Fallback', () => {
  test('withFallback replaces any error with the handler value', async ({ assert }) => {
    let seen: unknown
    const value = await Tenace.policy()
      .withFallback(error => ((seen = error), 'fallback'))
      .execute(fail)
    assert.equal(value, 'fallback')
    assert.instanceOf(seen, UnexpectedError)
  })

  test('the handler is not called on success', async ({ assert }) => {
    let called = false
    assert.equal(
      await Tenace.policy()
        .withFallback(() => (called = true))
        .execute(() => 'live'),
      'live',
    )
    assert.isFalse(called)
  })

  test('the handler may be async and return ok() or err()', async ({ assert }) => {
    assert.equal(
      await Tenace.policy()
        .withFallback(async () => ok('async'))
        .execute(fail),
      'async',
    )

    const notFound = new NotFound('x')
    assert.deepEqual(
      await Tenace.policy()
        .withFallback(() => err(notFound))
        .settle(fail),
      err(notFound),
    )
  })

  test('the handler receives the context', async ({ assert }) => {
    const controller = new AbortController()
    const signal = await Tenace.policy()
      .withFallback((_error, context) => context.signal)
      .execute(fail, { signal: controller.signal })
    assert.strictEqual(signal, controller.signal)
  })

  test('withFallbackOn only handles the listed tags', async ({ assert }) => {
    const policy = Tenace.policy<NotFound>()
      .with(new Explode())
      .withFallbackOn(['BoomError'], error => `handled ${error._tag}`)

    assert.equal(await policy.execute(() => 'x'), 'handled BoomError')
    const notFound = new NotFound('x')
    assert.deepEqual(await policy.settle(() => err(notFound)), err(notFound))
  })

  test('withFallbackWhen handles errors matched by the guard', async ({ assert }) => {
    const policy = Tenace.policy<NotFound>().withFallbackWhen(
      error => error instanceof NotFound,
      error => `missing ${error.message}`,
    )
    assert.equal(await policy.execute(() => err(new NotFound('user'))), 'missing user')
    await assert.rejects(() => policy.execute(fail), 'down')
  })

  test('a fallback after a timeout handles it', async ({ assert }) => {
    const clock = new TestClock()
    const done = Tenace.policy()
      .withTimeout(100)
      .withFallbackOn(['TimeoutError'], error => error.timeoutMs)
      .execute(() => new Promise(() => {}), { clock })
    await clock.advance(100)
    assert.equal(await done, 100)
  })

  test('is not run when the caller aborted', async ({ assert }) => {
    const controller = new AbortController()
    let called = false
    const done = Tenace.policy()
      .withFallback(() => (called = true))
      .settle(() => new Promise(() => {}), { signal: controller.signal })
    controller.abort('stop')
    assert.equal(await done.catch((error: unknown) => error), 'stop')
    assert.isFalse(called)
  })

  test('a throwing handler is a bug: the execution rejects with the thrown value', async ({
    assert,
  }) => {
    const bug = new Error('bug')
    const settled = Tenace.policy()
      .withFallback(() => {
        throw bug
      })
      .settle(fail)
    assert.strictEqual(await settled.catch((error: unknown) => error), bug)
  })

  test('an inner fallback hides errors from outer strategies', async ({ assert }) => {
    let attempts = 0
    const value = await Tenace.policy()
      .withFallback(() => 'inner')
      .withRetry({ retries: 3, delay: 0 })
      .execute(() => (attempts++, fail()))
    assert.equal(value, 'inner')
    assert.equal(attempts, 1)
  })
})

test.group('mapError', () => {
  test('transforms every error', async ({ assert }) => {
    const result = await Tenace.policy()
      .withTimeout(1000)
      .mapError(error => (error instanceof TimeoutError ? 'timeout' : 'other'))
      .settle(fail)
    assert.deepEqual(result, err('other'))
  })

  test('leaves successes alone', async ({ assert }) => {
    assert.deepEqual(
      await Tenace.policy()
        .mapError(() => 'mapped')
        .settle(() => 1),
      ok(1),
    )
  })

  test('mapped errors are known errors for execute()', async ({ assert }) => {
    const policy = Tenace.policy().mapError(() => new BoomError('mapped'))
    const thrown = await policy.execute(fail).catch((error: unknown) => error)
    assert.instanceOf(thrown, BoomError)
    assert.isTrue(policy.isError(thrown))
  })
})
