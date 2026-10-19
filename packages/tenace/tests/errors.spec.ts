import { test } from '@japa/runner'

import { isTenaceError, TenaceError, UnexpectedError } from '../src/errors.ts'
import type * as ErrorsModule from '../src/errors.ts'

class HttpError extends TenaceError {
  static readonly tag = 'HttpError'
  readonly _tag = 'HttpError' as const
  readonly code = 'E_HTTP' as const
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

class UntaggedStaticError extends TenaceError {
  readonly _tag = 'UntaggedStaticError' as const
  readonly code = 'E_UNTAGGED' as const
}

test.group('TenaceError', () => {
  test('instanceof works for the base class and the exact subclass only', ({ assert }) => {
    const http = new HttpError(503)
    const unexpected = new UnexpectedError(new Error('boom'))

    assert.isTrue(http instanceof TenaceError)
    assert.isTrue(http instanceof Error)
    assert.isTrue(http instanceof HttpError)
    assert.isFalse(http instanceof UnexpectedError)
    assert.isFalse(unexpected instanceof HttpError)
    assert.isFalse(new Error('x') instanceof TenaceError)
    assert.isFalse({ _tag: 'HttpError' } instanceof HttpError)
  })

  test('subclasses without a static tag use the prototype chain', ({ assert }) => {
    const error = new UntaggedStaticError('x')
    assert.isTrue(error instanceof UntaggedStaticError)
    assert.isTrue(error instanceof TenaceError)
    assert.isFalse(new HttpError(500) instanceof UntaggedStaticError)
  })

  test('instanceof and isTenaceError work across copies of the module', async ({ assert }) => {
    const copy = (await import(
      // @ts-expect-error query string loads a second, independent copy of the module
      '../src/errors.ts?copy'
    )) as typeof ErrorsModule

    assert.notStrictEqual(copy.UnexpectedError, UnexpectedError)
    const foreign = new copy.UnexpectedError('x')

    assert.isTrue(foreign instanceof UnexpectedError)
    assert.isTrue(foreign instanceof TenaceError)
    assert.isTrue(isTenaceError(foreign))
    assert.isTrue(new UnexpectedError('x') instanceof copy.UnexpectedError)
    assert.isFalse(new HttpError(500) instanceof copy.UnexpectedError)
  })

  test('toJSON has tag, code, own fields and cause but no stack', ({ assert }) => {
    const json = JSON.parse(JSON.stringify(new HttpError(503)))
    assert.deepEqual(json, {
      _tag: 'HttpError',
      code: 'E_HTTP',
      status: 503,
      name: 'HttpError',
      message: 'HTTP 503',
    })

    const wrapped = JSON.parse(JSON.stringify(new UnexpectedError(new TypeError('bad'))))
    assert.deepEqual(wrapped, {
      _tag: 'UnexpectedError',
      code: 'E_UNEXPECTED',
      name: 'UnexpectedError',
      message: 'bad',
      cause: { name: 'TypeError', message: 'bad' },
    })
  })
})

test.group('UnexpectedError', () => {
  test('keeps the raw thrown value as cause', ({ assert }) => {
    const raw = new Error('boom')
    const error = new UnexpectedError(raw)
    assert.strictEqual(error.cause, raw)
    assert.equal(error.message, 'boom')
    assert.equal(error._tag, 'UnexpectedError')
    assert.equal(error.name, 'UnexpectedError')
  })

  test('accepts non-error thrown values', ({ assert }) => {
    assert.equal(new UnexpectedError('nope').message, 'nope')
    assert.equal(new UnexpectedError(42).cause, 42)
    assert.equal(new UnexpectedError(undefined).message, 'undefined')
  })

  test('accepts thrown values that cannot be converted to a string', ({ assert }) => {
    const bare = Object.create(null) as object
    const hostile = {
      toString() {
        throw new Error('no')
      },
    }
    assert.equal(new UnexpectedError(bare).message, '[object Object]')
    assert.strictEqual(new UnexpectedError(bare).cause, bare)
    assert.equal(new UnexpectedError(hostile).message, '[object Object]')
  })
})

test.group('TenaceError | logging', () => {
  test('name defaults to the class name and is not an enumerable field', ({ assert }) => {
    const error = new HttpError(500)
    assert.equal(error.name, 'HttpError')
    assert.deepEqual(Object.keys(error), ['_tag', 'code', 'status'])
    assert.match(String(error), /^HttpError: HTTP 500/)
  })
})
