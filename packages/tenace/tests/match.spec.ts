import { test } from '@japa/runner'

import { TenaceError, UnexpectedError } from '../src/errors.ts'
import { Result } from '../src/result/namespace.ts'

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
      Result.ok(1),
      Result.err(new NotFound('user')),
      Result.err(new UnexpectedError('boom')),
    ]
    assert.deepEqual(
      results.map(result => Result.match(result, handlers)),
      ['ok:1', 'not-found:user', 'unexpected:boom'],
    )
  })

  test('`_` handles every error without its own handler, tagged or not', ({ assert }) => {
    const tagged: Result<number, NotFound | UnexpectedError> = Result.err(
      new UnexpectedError('boom'),
    )
    const untagged: Result<number, string> = Result.err('plain')

    assert.equal(
      Result.match(tagged, { ok: () => 'ok', NotFound: () => 'nf', _: () => 'rest' }),
      'rest',
    )
    assert.equal(
      Result.match(untagged, { ok: () => 'ok', _: error => `rest:${error}` }),
      'rest:plain',
    )
  })

  test('a specific handler wins over `_`', ({ assert }) => {
    const result: Result<number, NotFound> = Result.err(new NotFound('x'))
    assert.equal(
      Result.match(result, { ok: () => 'ok', NotFound: () => 'nf', _: () => 'rest' }),
      'nf',
    )
  })

  test('only own handlers match a tag', ({ assert }) => {
    const cases = { ok: () => 'ok', _: () => 'rest' }
    for (const _tag of ['toString', 'constructor', 'ok']) {
      const result = Result.err({ _tag }) as Result<number, never>
      assert.equal(Result.match(result, cases as never), 'rest')
    }
  })

  test('rethrows an error without handler (untyped input)', ({ assert }) => {
    const boom = new Error('boom')
    const result = Result.err(boom) as Result<number, never>
    assert.throws(() => Result.match(result, { ok: () => 'ok' }), 'boom')
  })
})
