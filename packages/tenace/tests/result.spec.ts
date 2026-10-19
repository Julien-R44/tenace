import { test } from '@japa/runner'

import { err, isResult, ok } from '../src/result.ts'
import type * as ResultModule from '../src/result.ts'

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
      '../src/result.ts?copy'
    )) as typeof ResultModule
    assert.isTrue(isResult(copy.err('x')))
  })
})
