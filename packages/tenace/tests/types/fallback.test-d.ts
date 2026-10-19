import { TenaceError, type TimeoutError, type UnexpectedError } from '../../src/errors.ts'
import type { OtherError } from '../../src/fold.ts'
import type { ErrorOf } from '../../src/policy.ts'
import { err, ok, type Result } from '../../src/result.ts'
import { Tenace } from '../../src/tenace.ts'
import { Explode, NotFound, type BoomError } from '../helpers/strategies.ts'
import { type Equal, expectType } from './helpers.ts'

class HttpError extends TenaceError {
  readonly _tag = 'HttpError' as const
  readonly code = 'E_HTTP' as const
  readonly status: number = 500
}
type User = { id: string }
declare const fetchUser: () => Promise<User>
declare const findUser: () => Promise<Result<User, NotFound>>

/* ---- catch-all ---- */
const safe = Tenace.policy()
  .withTimeout(10)
  .withFallback(
    error => (expectType<Equal<typeof error, UnexpectedError | OtherError | TimeoutError>>(), 0),
  )
expectType<Equal<ErrorOf<typeof safe>, never>>()
const s1 = await safe.settle(findUser)
expectType<Equal<typeof s1, Result<User | number, never>>>()

/* ---- by tag ---- */
const byTag = Tenace.policy()
  .withTimeout(10)
  .withFallbackOn(
    ['TimeoutError'],
    error => (expectType<Equal<typeof error, TimeoutError>>(), null),
  )
expectType<Equal<ErrorOf<typeof byTag>, UnexpectedError>>()
const v2 = await byTag.execute(fetchUser)
expectType<Equal<typeof v2, User | null>>()
// several tags
Tenace.call(findUser)
  .withTimeout(10)
  .withFallbackOn(['TimeoutError', 'NotFound'], error =>
    expectType<Equal<typeof error, TimeoutError | NotFound>>(),
  )
// @ts-expect-error unknown tag
Tenace.policy().withFallbackOn(['TimeoutError'], () => null)

/* ---- by guard ---- */
const byGuard = Tenace.policy<HttpError>().withFallbackWhen(
  error => error instanceof HttpError,
  error => (expectType<Equal<typeof error, HttpError>>(), error.status),
)
expectType<Equal<ErrorOf<typeof byGuard>, UnexpectedError>>()
const s3 = await byGuard.settle(fetchUser)
expectType<Equal<typeof s3, Result<User | number, UnexpectedError>>>()

// a plain predicate handles some errors but removes nothing
const byPredicate = Tenace.policy<HttpError>().withFallbackWhen(
  error => error instanceof HttpError && error.status === 404,
  error => expectType<Equal<typeof error, HttpError | UnexpectedError | OtherError>>(),
)
expectType<Equal<ErrorOf<typeof byPredicate>, HttpError | UnexpectedError>>()

// a guard on a subclass removes the subclass only, not every error with its tag
class NotFoundHttp extends HttpError {
  readonly notFound = true
}
const bySubclass = Tenace.policy<HttpError>().withFallbackWhen(
  error => error instanceof NotFoundHttp,
  () => null,
)
expectType<Equal<ErrorOf<typeof bySubclass>, HttpError | UnexpectedError>>()

// untagged errors match structurally, so a guard on one of them removes nothing
class AErr extends Error {}
class BErr extends Error {}
declare const ab: () => Promise<Result<User, AErr | BErr>>
const s3b = await Tenace.call(ab)
  .withFallbackWhen(
    error => error instanceof AErr,
    () => null,
  )
  .settle()
expectType<Equal<typeof s3b, Result<User | null, AErr | BErr | UnexpectedError>>>()

/* ---- handlers returning Results ---- */
const toErr = Tenace.policy()
  .withTimeout(10)
  .withFallbackOn(['TimeoutError'], () => err(new NotFound('x')))
expectType<Equal<ErrorOf<typeof toErr>, UnexpectedError | NotFound>>()
const toOk = Tenace.policy()
  .withTimeout(10)
  .withFallbackOn(['TimeoutError'], async () => ok('cached' as const))
const v4 = await toOk.execute(fetchUser)
expectType<Equal<typeof v4, User | 'cached'>>()
const mixed = Tenace.policy().withFallback(() =>
  Math.random() > 0.5 ? ok(1) : err(new NotFound('x')),
)
const s5 = await mixed.settle(fetchUser)
expectType<Equal<typeof s5, Result<User | number, NotFound>>>()

// re-raising an undeclared error keeps the errors of the function
const reRaised = Tenace.policy()
  .withTimeout(10)
  .withFallback(error => (error._tag === 'TimeoutError' ? ok(null) : err(error)))
const s5b = await reRaised.settle(findUser)
expectType<Equal<typeof s5b, Result<User | null, NotFound | UnexpectedError | TimeoutError>>>()

/* ---- an outer strategy re-adds a removed error ---- */
const reAdded = Tenace.policy()
  .withFallback(() => null)
  .with(new Explode())
expectType<Equal<ErrorOf<typeof reAdded>, BoomError>>()

/* ---- mapError ---- */
const mapped = Tenace.policy<HttpError>().mapError(error =>
  error._tag === 'HttpError' ? error : new NotFound('x'),
)
expectType<Equal<ErrorOf<typeof mapped>, HttpError | NotFound>>()
const s6 = await Tenace.call(findUser)
  .mapError(() => 'failed' as const)
  .settle()
expectType<Equal<typeof s6, Result<User, 'failed'>>>()

// mapping undeclared errors through keeps the errors of the function
class Wrapped extends TenaceError {
  readonly _tag = 'Wrapped' as const
  readonly code = 'E_WRAPPED' as const
}
const s6b = await Tenace.policy()
  .withTimeout(10)
  .mapError(error => (error._tag === 'TimeoutError' ? new Wrapped('x') : error))
  .settle(findUser)
expectType<Equal<typeof s6b, Result<User, Wrapped | NotFound | UnexpectedError | TimeoutError>>>()

/* ---- fallback values flow through policy of policies ---- */
const outer = Tenace.policy().with(byTag).withTimeout(100)
const v7 = await outer.execute(fetchUser)
expectType<Equal<typeof v7, User | null>>()
