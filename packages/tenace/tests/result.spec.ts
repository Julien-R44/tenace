import { test } from '@japa/runner'

import { UnexpectedError } from '../src/errors.ts'
import { err, isResult, ok } from '../src/result/core.ts'
import { Result } from '../src/result/index.ts'
import type * as ResultModule from '../src/result/core.ts'

test.group('Result', () => {
  test('ok and err build plain branded objects', ({ assert }) => {
    const success = ok(1)
    const failure = err('nope')

    assert.isTrue(success.ok)
    assert.equal(success.value, 1)
    assert.isFalse(failure.ok)
    assert.equal(failure.error, 'nope')
    assert.isTrue(isResult(success))
    assert.isTrue(isResult(failure))
    assert.isTrue(isResult(ok()))
  })

  test('the brand is invisible to JSON and spreading', ({ assert }) => {
    assert.equal(JSON.stringify(ok(1)), '{"ok":true,"value":1}')
    assert.deepEqual(Object.keys(err('x')), ['ok', 'error'])
    assert.isFalse(isResult({ ...ok(1) }))
  })

  test('look-alike payloads are not results', ({ assert }) => {
    assert.isFalse(isResult({ ok: false, error: 'channel_not_found' }))
    assert.isFalse(isResult({ ok: true, value: 1 }))
    assert.isFalse(isResult(null))
    assert.isFalse(isResult('ok'))
  })

  test('results from another copy of the module are recognized', async ({ assert }) => {
    const copy = (await import(
      // @ts-expect-error query string loads a second, independent copy of the module
      '../src/result/core.ts?copy'
    )) as typeof ResultModule
    assert.isTrue(isResult(copy.err('x')))
  })
})

test.group('Result namespace', () => {
  test('try returns the value, or the thrown value as an UnexpectedError', ({ assert }) => {
    const boom = new Error('boom')
    const success = Result.try(() => 1)
    const failure = Result.try(() => {
      throw boom
    })

    assert.deepEqual(success, Result.ok(1))
    assert.isFalse(failure.ok)
    assert.instanceOf(Result.unwrapErr(failure), UnexpectedError)
    assert.strictEqual(Result.unwrapErr(failure).cause, boom)
  })

  test('try builds the error with catch', ({ assert }) => {
    const failure = Result.try({
      try: () => JSON.parse('{'),
      catch: cause => ({ _tag: 'InvalidJson' as const, cause }),
    })
    const error = Result.unwrapErr(failure, 'InvalidJson')
    assert.instanceOf(error.cause, SyntaxError)
  })

  test('try awaits promises and maps rejections', async ({ assert }) => {
    const success = await Result.try(async () => 'value')
    const failure = await Result.try({
      try: () => Promise.reject(new Error('down')),
      catch: cause => `mapped:${(cause as Error).message}`,
    })

    assert.deepEqual(success, Result.ok('value'))
    assert.equal(Result.unwrapErr(failure), 'mapped:down')
  })

  test('try returns a returned Result as is, and keeps look-alikes as values', async ({
    assert,
  }) => {
    const notFound = { _tag: 'NotFound' as const }
    const lookAlike = { ok: false, error: 'x' }

    assert.strictEqual(Result.unwrapErr(Result.try(() => Result.err(notFound))), notFound)
    assert.strictEqual(
      Result.unwrapErr(await Result.try(async () => Result.err(notFound))),
      notFound,
    )
    assert.strictEqual(Result.unwrap(Result.try(() => lookAlike)), lookAlike)
  })

  test('all returns every value in order, or the first error in input order', ({ assert }) => {
    assert.deepEqual(Result.all([Result.ok(1), Result.ok('a')]), Result.ok([1, 'a']))
    assert.deepEqual(Result.all([]), Result.ok([]))
    assert.deepEqual(
      Result.all([Result.ok(1), Result.err('first'), Result.err('second')]),
      Result.err('first'),
    )
  })

  test('partition splits values and errors, each in input order', ({ assert }) => {
    const results = [Result.err('a'), Result.ok(1), Result.err('b'), Result.ok(2)]
    assert.deepEqual(Result.partition(results), { values: [1, 2], errors: ['a', 'b'] })
  })

  test('try returns a promise only when fn does, even if fn is typed sync or async', async ({
    assert,
  }) => {
    const read = (cached: boolean) => (cached ? 'cached' : Promise.resolve('fetched'))
    const sync = Result.try(() => read(true))
    const async = Result.try(() => read(false))

    assert.deepEqual(sync, Result.ok('cached'))
    assert.instanceOf(async, Promise)
    assert.deepEqual(await async, Result.ok('fetched'))
  })

  test('unwrap returns the value, or throws what execute() rejects with', ({ assert }) => {
    const error = new Error('nope')
    const thrown = new Error('raw')
    assert.equal(Result.unwrap(Result.ok(1)), 1)
    assert.throws(() => Result.unwrap(Result.err(error)), 'nope')

    for (const result of [
      Result.err(new UnexpectedError(thrown)),
      Result.try(() => {
        throw thrown
      }),
    ]) {
      try {
        Result.unwrap(result)
        assert.fail('should throw')
      } catch (caught) {
        assert.strictEqual(caught, thrown)
      }
    }

    try {
      Result.unwrap(Result.err('plain'))
      assert.fail('should throw')
    } catch (thrown) {
      assert.equal(thrown, 'plain')
    }
  })

  test('unwrapErr checks the Result and the tag of its error', ({ assert }) => {
    const notFound = { _tag: 'NotFound' as const }
    const result = Result.err(notFound) as Result<number, typeof notFound | { _tag: 'Gone' }>

    assert.strictEqual(Result.unwrapErr(result), notFound)
    assert.strictEqual(Result.unwrapErr(result, 'NotFound'), notFound)
    assert.throws(() => Result.unwrapErr(result, 'Gone'), 'Expected tag "Gone", got "NotFound"')
    const untagged: Result<number, { _tag: 'Gone' } | string> = Result.err('plain')
    assert.throws(
      () => Result.unwrapErr(untagged, 'Gone'),
      'Expected tag "Gone", got an untagged error',
    )
    assert.throws(() => Result.unwrapErr(Result.ok(1)), 'Expected an err Result, got an ok Result')
  })
})
