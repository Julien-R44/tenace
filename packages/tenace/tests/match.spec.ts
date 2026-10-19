import { test } from '@japa/runner'

import { TenaceError, UnexpectedError } from '../src/errors.ts'
import { match } from '../src/match.ts'
import { err, ok, type Result } from '../src/result.ts'

class NotFound extends TenaceError {
  readonly _tag = 'NotFound' as const
  readonly code = 'E_NOT_FOUND' as const
}

const handlers = {
  ok: (value: number) => `ok:${value}`,
  NotFound: (error: NotFound) => `not-found:${error.message}`,
  UnexpectedError: (error: UnexpectedError) => `unexpected:${String(error.cause)}`,
}

test.group('match', () => {
  test('dispatches ok and each error tag to its handler', ({ assert }) => {
    const results: Result<number, NotFound | UnexpectedError>[] = [
      ok(1),
      err(new NotFound('user')),
      err(new UnexpectedError('boom')),
    ]
    assert.deepEqual(
      results.map(result => match(result, handlers)),
      ['ok:1', 'not-found:user', 'unexpected:boom'],
    )
  })

  test('`_` handles every error without its own handler, tagged or not', ({ assert }) => {
    const tagged: Result<number, NotFound | UnexpectedError> = err(new UnexpectedError('boom'))
    const untagged: Result<number, string> = err('plain')

    assert.equal(match(tagged, { ok: () => 'ok', NotFound: () => 'nf', _: () => 'rest' }), 'rest')
    assert.equal(match(untagged, { ok: () => 'ok', _: error => `rest:${error}` }), 'rest:plain')
  })

  test('a specific handler wins over `_`', ({ assert }) => {
    const result: Result<number, NotFound> = err(new NotFound('x'))
    assert.equal(match(result, { ok: () => 'ok', NotFound: () => 'nf', _: () => 'rest' }), 'nf')
  })

  test('only own handlers match a tag', ({ assert }) => {
    const cases = { ok: () => 'ok', _: () => 'rest' }
    for (const _tag of ['toString', 'constructor', 'ok']) {
      const result = err({ _tag }) as Result<number, never>
      assert.equal(match(result, cases as never), 'rest')
    }
  })

  test('rethrows an error without handler (untyped input)', ({ assert }) => {
    const boom = new Error('boom')
    const result = err(boom) as Result<number, never>
    assert.throws(() => match(result, { ok: () => 'ok' }), 'boom')
  })
})
