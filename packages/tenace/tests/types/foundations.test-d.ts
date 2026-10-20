import { TenaceError, UnexpectedError } from '../../src/errors.ts'
import { Result } from '../../src/result/namespace.ts'
import { type Duration, toMs } from '../../src/duration.ts'
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
const okCount = () => Result.ok({ count: 0 })
declare const result: Result<User, AppError>

/* ---- result constructors and extractors ---- */
expectType<Equal<ReturnType<typeof Result.ok<'a'>>, Result.Ok<'a'>>>()
assertType<Result.Ok<void>>(Result.ok())
// values keep their regular (mutable, widened) types
expectType<Equal<ReturnType<typeof okCount>, Result.Ok<{ count: number }>>>()
declare const users: User[]
const listed = users.length > 0 ? Result.ok(users) : Result.ok([])
assertType<Result.Ok<User[]>>(listed)
expectType<Equal<Result.ValueOf<Result<User, AppError>>, User>>()
expectType<Equal<Result.ErrorOf<Result<User, AppError>>, AppError>>()
const literal = Result.err('nope')
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
const view = Result.match(result, {
  ok: user => user.id,
  NotFound: () => 404 as const,
  HttpError: error => error.status,
  Gone: () => 410 as const,
  UnexpectedError: error => (assertType<unknown>(error.cause), null),
})
expectType<Equal<typeof view, string | number | null>>()

// @ts-expect-error UnexpectedError and Gone are not handled
Result.match(result, { ok: () => 1, NotFound: () => 2, HttpError: () => 3 })

const rest = Result.match(result, {
  ok: () => 'ok' as const,
  NotFound: () => 'nf' as const,
  _: () => 'rest' as const,
})
expectType<Equal<typeof rest, 'ok' | 'nf' | 'rest'>>()

// `_` receives the whole union
Result.match(result, { ok: () => 0, _: error => expectType<Equal<typeof error, AppError>>() })

// @ts-expect-error `ok` is mandatory
Result.match(result, { _: () => 0 })

// @ts-expect-error unknown tags are rejected
Result.match(result, { ok: () => 0, Nope: () => 1, _: () => 2 })

// untagged errors: only `_`
declare const plain: Result<number, string>
const plainView = Result.match(plain, { ok: value => value, _: error => error.length })
expectType<Equal<typeof plainView, number>>()
// @ts-expect-error untagged errors need `_`
Result.match(plain, { ok: value => value })

// mixed: tagged members get handlers, untagged ones still need `_`
declare const mixed: Result<User, 'nope' | Error | NotFound>
// @ts-expect-error 'nope' and Error have no tag
Result.match(mixed, { ok: () => 0, NotFound: () => 1 })
Result.match(mixed, { ok: () => 0, NotFound: () => 1, _: () => 2 })
declare const opaque: Result<User, unknown>
// @ts-expect-error an unknown error needs `_`
Result.match(opaque, { ok: () => 0 })

/* ---- durations ---- */
const durations: Duration[] = [100, '100ms', '1.5s', '2m', '1h', '1d']
void durations
// @ts-expect-error unknown unit
toMs('10sec')

/* ---- match infers the union of a function with several returns ---- */
function signup(email: string) {
  if (email === '') return Result.err(new NotFound('user'))
  if (email === 'taken') return Result.err(new Gone('user'))
  return Result.ok({ id: email })
}
const signupView = Result.match(signup('a'), {
  ok: user => user.id,
  NotFound: () => 404,
  Gone: () => 410,
})
expectType<Equal<typeof signupView, string | number>>()
// @ts-expect-error Gone is not handled
Result.match(signup('a'), { ok: () => 0, NotFound: () => 404 })

/* ---- Result namespace ---- */
// a failed Result passes through to a Result with another value type
async function rename(id: string): Promise<Result<string, NotFound | Gone>> {
  const found = await Promise.resolve(result as Result<User, NotFound>)
  if (!found.ok) return found
  return id === '' ? Result.err(new Gone('user')) : Result.ok(found.value.id)
}
void rename

assertType<Result<User, AppError>>(result)
assertType<Result.Ok<User> | Result.Err<AppError>>(result)
expectType<Equal<Result.ValueOf<typeof result>, User>>()
expectType<Equal<Result.ErrorOf<typeof result>, AppError>>()

// an `unknown` return may be any `Result.err(...)`, as with policies, or a promise
const parsed = Result.try(() => JSON.parse('{}') as unknown)
expectType<Equal<typeof parsed, Result<unknown, unknown> | Promise<Result<unknown, unknown>>>>()
// a promise only sometimes: either one, and awaiting it always gives a Result
declare function readUser(cached: boolean): User | Promise<User>
const sometimes = Result.try(() => readUser(true))
expectType<
  Equal<typeof sometimes, Result<User, UnexpectedError> | Promise<Result<User, UnexpectedError>>>
>()
expectType<Equal<Awaited<typeof sometimes>, Result<User, UnexpectedError>>>()
// `any` (parsed JSON) and `never` (always throws) are not async
const parsedAny = Result.try(() => JSON.parse('{}'))
// oxlint-disable-next-line typescript/no-explicit-any
expectType<Equal<typeof parsedAny, Result<any, UnexpectedError>>>()
const thrown = Result.try(() => {
  throw new Error('boom')
})
expectType<Equal<typeof thrown, Result<never, UnexpectedError>>>()
const url = Result.try({
  try: () => new URL('x'),
  catch: cause => (expectType<Equal<typeof cause, unknown>>(), new NotFound('url')),
})
expectType<Equal<typeof url, Result<URL, NotFound>>>()
const charged = Result.try({ try: async () => 42, catch: () => 'declined' as const })
expectType<Equal<typeof charged, Promise<Result<number, 'declined'>>>>()
const toError = () => 'x'
// @ts-expect-error the positional mapper is gone, use { try, catch }
Result.try(() => 1, toError)
const fetched = Result.try(async () => ({ id: '1' }) as User)
expectType<Equal<typeof fetched, Promise<Result<User, UnexpectedError>>>>()
// a returned Result is flattened, sync or async
const flattened = Result.try(() => result)
assertType<Result<User, AppError | UnexpectedError>>(flattened)
assertType<typeof flattened>(Result.err(new UnexpectedError('x')))
// @ts-expect-error the value is User, not a nested Result
assertType<typeof flattened>(Result.ok(result))
const flattenedAsync = Result.try(() => signupAsync())
expectType<
  Equal<Awaited<typeof flattenedAsync>, Result<{ id: string }, NotFound | Gone | UnexpectedError>>
>()
async function signupAsync() {
  return signup('a')
}

declare const rows: Result<User, NotFound>[]
expectType<Equal<typeof allRows, Result<User[], NotFound>>>()
const allRows = Result.all(rows)
const pair = Result.all([Result.ok(1), result])
expectType<Equal<typeof pair, Result<[number, User], AppError>>>()
const split = Result.partition([Result.ok(1), result])
expectType<Equal<typeof split, { values: (number | User)[]; errors: AppError[] }>>()

expectType<Equal<ReturnType<typeof Result.unwrap<typeof result>>, User>>()
const gone = Result.unwrapErr(result, 'Gone')
expectType<Equal<typeof gone, Gone>>()
expectType<Equal<ReturnType<typeof Result.unwrapErr<typeof result>>, AppError>>()
// @ts-expect-error unknown tags are rejected
Result.unwrapErr(result, 'Nope')
