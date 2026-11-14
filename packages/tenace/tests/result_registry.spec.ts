import { test } from '@japa/runner'

import { Clock } from '../src/clock/clock.ts'
import { UnexpectedError } from '../src/errors.ts'
import { Result } from '../src/result/index.ts'
import { registerResult, unregisterResult } from '../src/result/registry.ts'
import { Tenace } from '../src/tenace.ts'
import { AppErr, AppOk } from './helpers/app_result.ts'
import { NotFound } from './helpers/strategies.ts'

test.group('Result registry', group => {
  group.each.teardown(() => unregisterResult('app'))

  const registerApp = () =>
    registerResult('app', value =>
      value instanceof AppOk
        ? Result.ok(value.data)
        : value instanceof AppErr
          ? Result.err(value.failure)
          : undefined,
    )

  test('foreign results are unwrapped once registered', async ({ assert }) => {
    registerApp()
    const notFound = new NotFound('x')

    assert.equal(await Tenace.policy().execute(() => new AppOk(1)), 1)
    assert.deepEqual(
      await Tenace.policy().settle(async () => new AppErr(notFound)),
      Result.err(notFound),
    )

    const clock = new Clock()
    using time = clock.fake(new Date(0)).letTimePass()
    let checks = 0
    const ready = await clock.waitFor(async () => new AppOk(++checks === 2))
    assert.isTrue(ready.ok)
    assert.equal(checks, 2)
    const job = await clock.poll(() => new AppOk({ ready: true }), { until: job => job.ready })
    assert.deepEqual(Result.unwrap(job), { ready: true })
    assert.strictEqual(Result.unwrapErr(await clock.waitFor(() => new AppErr(notFound))), notFound)
    assert.equal(time.pendingTimers, 0)
  })

  test('foreign results are plain values when nothing is registered', async ({ assert }) => {
    const value = new AppErr('x')
    assert.strictEqual(await Tenace.policy().execute(() => value), value)
  })

  test('other values are untouched by adapters', async ({ assert }) => {
    registerApp()
    assert.equal(await Tenace.policy().execute(() => 'plain'), 'plain')
  })

  test('a throwing adapter becomes an UnexpectedError', async ({ assert }) => {
    const bug = new Error('adapter bug')
    registerResult('app', () => {
      throw bug
    })
    const isBug = (result: Result<unknown, unknown>) =>
      !result.ok && result.error instanceof UnexpectedError && result.error.cause === bug

    assert.isTrue(isBug(await Tenace.policy().settle(() => 1)))
    assert.isTrue(isBug(Result.try(() => 1)))
    assert.isTrue(isBug(await Result.try(async () => 1)))
  })

  test('registering again replaces the adapter, unregister removes it', async ({ assert }) => {
    registerApp()
    registerResult('app', value => (value instanceof AppOk ? Result.ok('replaced') : undefined))
    assert.equal(await Tenace.policy().execute(() => new AppOk(1)), 'replaced')

    unregisterResult('app')
    const value = new AppOk(1)
    assert.strictEqual(await Tenace.policy().execute(() => value), value)
  })
})
