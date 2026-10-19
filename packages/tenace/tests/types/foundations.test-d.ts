import { TenaceError, type UnexpectedError } from '../../src/errors.ts'
import { match } from '../../src/match.ts'
import { type Duration, toMs } from '../../src/duration.ts'
import {
  err,
  type ErrorOfResult,
  ok,
  type Ok,
  type Result,
  type ValueOf,
} from '../../src/result.ts'
import type { ByTag, TagOf } from '../../src/types.ts'
import { assertType, type Equal, expectType } from './helpers.ts'

class NotFound extends TenaceError {
  readonly _tag = 'NotFound' as const
  readonly code = 'E_NOT_FOUND' as const
}
class HttpError extends TenaceError {
  readonly _tag = 'HttpError' as const
  readonly code = 'E_HTTP' as const
  readonly status: number = 500
}
/** Same shape as NotFound except the tag: must stay distinct in unions. */
class Gone extends TenaceError {
  readonly _tag = 'Gone' as const
  readonly code = 'E_NOT_FOUND' as const
}
type User = { id: string }
type AppError = NotFound | HttpError | Gone | UnexpectedError
const okCount = () => ok({ count: 0 })
declare const result: Result<User, AppError>

/* ---- result constructors and extractors ---- */
expectType<Equal<typeof ok, typeof ok>>()
expectType<Equal<ReturnType<typeof ok<'a'>>, Ok<'a'>>>()
assertType<Ok<void>>(ok())
// values keep their regular (mutable, widened) types
expectType<Equal<ReturnType<typeof okCount>, Ok<{ count: number }>>>()
declare const users: User[]
const listed = users.length > 0 ? ok(users) : ok([])
assertType<Ok<User[]>>(listed)
expectType<Equal<ValueOf<Result<User, AppError>>, User>>()
expectType<Equal<ErrorOfResult<Result<User, AppError>>, AppError>>()
const literal = err('nope')
expectType<Equal<typeof literal.error, 'nope'>>()

/* ---- tags ---- */
expectType<Equal<TagOf<AppError>, 'NotFound' | 'HttpError' | 'Gone' | 'UnexpectedError'>>()
expectType<Equal<TagOf<string | Error>, never>>()
expectType<Equal<ByTag<AppError, 'HttpError'>, HttpError>>()
expectType<
  Equal<Exclude<AppError, { readonly _tag: 'NotFound' }>, HttpError | Gone | UnexpectedError>
>()

/* ---- instanceof narrows, the else branch keeps the rest ---- */
if (!result.ok) {
  if (result.error instanceof HttpError) assertType<number>(result.error.status)
  else expectType<Equal<typeof result.error, NotFound | Gone | UnexpectedError>>()
}

/* ---- match ---- */
const view = match(result, {
  ok: user => user.id,
  NotFound: () => 404 as const,
  HttpError: error => error.status,
  Gone: () => 410 as const,
  UnexpectedError: error => (assertType<unknown>(error.cause), null),
})
expectType<Equal<typeof view, string | number | null>>()

// @ts-expect-error UnexpectedError and Gone are not handled
match(result, { ok: () => 1, NotFound: () => 2, HttpError: () => 3 })

const rest = match(result, {
  ok: () => 'ok' as const,
  NotFound: () => 'nf' as const,
  _: () => 'rest' as const,
})
expectType<Equal<typeof rest, 'ok' | 'nf' | 'rest'>>()

// `_` receives the whole union
match(result, { ok: () => 0, _: error => expectType<Equal<typeof error, AppError>>() })

// @ts-expect-error `ok` is mandatory
match(result, { _: () => 0 })

// @ts-expect-error unknown tags are rejected
match(result, { ok: () => 0, Nope: () => 1, _: () => 2 })

// untagged errors: only `_`
declare const plain: Result<number, string>
const plainView = match(plain, { ok: value => value, _: error => error.length })
expectType<Equal<typeof plainView, number>>()
// @ts-expect-error untagged errors need `_`
match(plain, { ok: value => value })

// mixed: tagged members get handlers, untagged ones still need `_`
declare const mixed: Result<User, 'nope' | Error | NotFound>
// @ts-expect-error 'nope' and Error have no tag
match(mixed, { ok: () => 0, NotFound: () => 1 })
match(mixed, { ok: () => 0, NotFound: () => 1, _: () => 2 })
declare const opaque: Result<User, unknown>
// @ts-expect-error an unknown error needs `_`
match(opaque, { ok: () => 0 })

/* ---- durations ---- */
const durations: Duration[] = [100, '100ms', '1.5s', '2m', '1h', '1d']
void durations
// @ts-expect-error unknown unit
toMs('10sec')
