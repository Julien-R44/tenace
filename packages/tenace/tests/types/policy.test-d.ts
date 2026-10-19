import type { Context } from '../../src/context.ts'
import { TenaceError, type TimeoutError, type UnexpectedError } from '../../src/errors.ts'
import type { OtherError, ValueOfReturn } from '../../src/fold.ts'
import type { AnyPolicy, CurrentError, ErrorOf, Policy, ReusablePolicy } from '../../src/policy.ts'
import { err, ok, type Result } from '../../src/result.ts'
import { registerResult } from '../../src/result_registry.ts'
import type { AnyOp, AnyStrategy, Op, Strategy } from '../../src/strategy.ts'
import { Tenace } from '../../src/tenace.ts'
import { AppErr, AppOk, type AppResult } from '../helpers/app_result.ts'
import { type BoomError, Counter, Explode, type NotFound, Rescue } from '../helpers/strategies.ts'
import { assertType, type Equal, expectType } from './helpers.ts'

class HttpError extends TenaceError {
  readonly _tag = 'HttpError' as const
  readonly code = 'E_HTTP' as const
  readonly status: number = 500
}
type User = { id: string }
declare const fetchUser: () => Promise<User>
declare const findUser: () => Promise<Result<User, NotFound>>
declare const getHttp: (ctx: Context) => Promise<Result<User, HttpError>>

/* ---- a plain policy ---- */
const base = Tenace.policy()
expectType<Equal<ErrorOf<typeof base>, UnexpectedError>>()
expectType<Equal<CurrentError<typeof base>, UnexpectedError | OtherError>>()

const v1 = await base.execute(fetchUser)
expectType<Equal<typeof v1, User>>()
const s1 = await base.settle(fetchUser)
expectType<Equal<typeof s1, Result<User, UnexpectedError>>>()

// any fn is accepted, its errors are exact in the result
const s2 = await base.settle(findUser)
expectType<Equal<typeof s2, Result<User, NotFound | UnexpectedError>>>()
const v2 = await base.execute(findUser)
expectType<Equal<typeof v2, User>>()

// sync functions, ok() values, unions of results
const s3 = await base.settle(() => 1 as const)
expectType<Equal<typeof s3, Result<1, UnexpectedError>>>()
const s4 = await base.settle(() =>
  Math.random() > 0.5 ? ok('a' as const) : err(new HttpError('x')),
)
expectType<Equal<typeof s4, Result<'a', HttpError | UnexpectedError>>>()

// any / unknown / void / never returns (an unknown return may be any err(), an any return is a value)
// oxlint-disable-next-line typescript/no-explicit-any
const sAny = await base.settle((): any => 1)
// oxlint-disable-next-line typescript/no-explicit-any
expectType<Equal<typeof sAny, Result<any, UnexpectedError>>>()
const sUnknown = await base.settle((): unknown => err('boom'))
expectType<Equal<typeof sUnknown, Result<unknown, unknown>>>()
expectType<Equal<ErrorOf<ReturnType<typeof Tenace.call<() => unknown>>>, unknown>>()
const sVoid = await base.settle(() => {})
expectType<Equal<typeof sVoid, Result<void, UnexpectedError>>>()
const sNever = await base.settle((): never => {
  throw new Error('x')
})
expectType<Equal<typeof sNever, Result<never, UnexpectedError>>>()

// the function receives the context
await base.execute(ctx => expectType<Equal<typeof ctx, Context>>())
await base.execute(getHttp)

/* ---- strategies add and remove errors ---- */
const exploding = base.with(new Explode())
expectType<Equal<ErrorOf<typeof exploding>, UnexpectedError | BoomError>>()
const s5 = await exploding.settle(findUser)
expectType<Equal<typeof s5, Result<User, NotFound | UnexpectedError | BoomError>>>()

const rescued = exploding.with(new Rescue('fallback'))
expectType<Equal<ErrorOf<typeof rescued>, never>>()
const s6 = await rescued.settle(findUser)
expectType<Equal<typeof s6, Result<User | 'fallback', never>>>()
const v6 = await rescued.execute(fetchUser)
expectType<Equal<typeof v6, User | 'fallback'>>()

// strategies that add nothing keep the channel as is
const counted = base.with(new Counter())
expectType<Equal<ErrorOf<typeof counted>, UnexpectedError>>()

/* ---- policy of policies ---- */
const inner = Tenace.policy().with(new Explode()).with(new Rescue(null))
const outer = Tenace.policy().with(new Counter()).with(inner)
expectType<Equal<ErrorOf<typeof outer>, never>>()
const v7 = await outer.execute(fetchUser)
expectType<Equal<typeof v7, User | null>>()
// errors re-added after an inner removal
const reAdded = Tenace.policy().with(inner).with(new Explode())
expectType<Equal<ErrorOf<typeof reAdded>, BoomError>>()
// errors added inside a policy survive
const nestedAdd = Tenace.policy().with(Tenace.policy().with(new Explode()))
expectType<Equal<ErrorOf<typeof nestedAdd>, UnexpectedError | BoomError>>()

/* ---- declared input errors ---- */
const http = Tenace.policy<HttpError>()
expectType<Equal<ErrorOf<typeof http>, HttpError | UnexpectedError>>()
const s8 = await http.settle(fetchUser) // the final result only has what the fn can produce
expectType<Equal<typeof s8, Result<User, UnexpectedError>>>()

/* ---- execute() narrowing, undeclared errors of the function included ---- */
try {
  await exploding.execute(getHttp)
} catch (error) {
  if (exploding.isError(error)) expectType<Equal<typeof error, BoomError | OtherError>>()
}
try {
  await http.execute(getHttp)
} catch (error) {
  if (http.isError(error)) expectType<Equal<typeof error, HttpError | OtherError>>()
}
const timed = Tenace.policy().withTimeout('1s')
try {
  await timed.execute(findUser)
} catch (error) {
  if (timed.isError(error)) expectType<Equal<typeof error, TimeoutError | OtherError>>()
}

/* ---- Tenace.call binds the function and its exact errors ---- */
const call = Tenace.call(findUser)
expectType<Equal<ErrorOf<typeof call>, NotFound | UnexpectedError>>()
expectType<Equal<CurrentError<typeof call>, NotFound | UnexpectedError>>()
const s9 = await call.with(new Explode()).settle()
expectType<Equal<typeof s9, Result<User, NotFound | UnexpectedError | BoomError>>>()
const v9 = await call.with(inner).execute({ signal: AbortSignal.timeout(10) })
expectType<Equal<typeof v9, User | null>>()
const callWithPolicy = Tenace.call(fetchUser).with(exploding)
expectType<Equal<ErrorOf<typeof callWithPolicy>, UnexpectedError | BoomError>>()

// @ts-expect-error a bound call takes no function
void call.execute(fetchUser)
// @ts-expect-error a reusable policy needs a function
void base.execute()
// @ts-expect-error a bound call cannot be inlined into another policy
base.with(call)
// @ts-expect-error only strategies and policies compose
base.with({ name: 'nope' })

/* ---- registered foreign results ---- */
registerResult('app', value =>
  value instanceof AppOk
    ? ok(value.data)
    : value instanceof AppErr
      ? err(value.failure)
      : undefined,
)
// @ts-expect-error the name must be declared in ResultTypes
registerResult('nope', () => undefined)

declare const loadUser: () => Promise<AppResult<User, NotFound>>
const s10 = await base.settle(loadUser)
expectType<Equal<typeof s10, Result<User, NotFound | UnexpectedError>>>()
const v10 = await Tenace.call(loadUser).execute()
expectType<Equal<typeof v10, User>>()
expectType<
  Equal<ErrorOf<ReturnType<typeof Tenace.call<typeof loadUser>>>, NotFound | UnexpectedError>
>()

/* ---- variance: a policy widened to any ops can produce any error ---- */
const anyPolicies: AnyPolicy[] = [base, exploding, rescued, call, http]
void anyPolicies
expectType<Equal<CurrentError<AnyPolicy>, unknown>>()
const wider: Policy<readonly AnyOp[], unknown, unknown> = Tenace.policy().withTimeout(1)
const sWider = await wider.settle(fetchUser)
expectType<Equal<typeof sWider, Result<unknown, unknown>>>()
assertType<Policy<[], never, UnexpectedError | OtherError>>(Tenace.policy())

/* ---- variance: a strategy that removes fewer errors produces more ---- */
let removesAll = Tenace.policy().withFallback(() => null)
// @ts-expect-error a policy that removes nothing is not one that removes everything
removesAll = Tenace.policy().withFallbackWhen(
  () => false,
  () => null,
)
void removesAll
// removing more errors than declared is fine
assertType<Policy<[Op<never, never>], null, UnexpectedError | OtherError>>(
  Tenace.policy().withFallback(() => null),
)
// @ts-expect-error a strategy that removes nothing is not one that removes everything
assertType<Strategy<never, unknown>>(new Counter())
assertType<Strategy<never, never, null>>(new Rescue(null))
assertType<AnyStrategy>(new Rescue(null))
assertType<AnyStrategy>(new Explode())

/* ---- typing a policy parameter ---- */
const runAny = async (policy: ReusablePolicy): Promise<void> => {
  const value = await policy.execute(fetchUser)
  expectType<Equal<typeof value, unknown>>()
  const extended = await policy.withTimeout('1s').withRetry({ retries: 1 }).settle(fetchUser)
  expectType<Equal<typeof extended, Result<unknown, unknown>>>()
}
const runPlain = async (policy: ReusablePolicy<never>): Promise<User> => policy.execute(fetchUser)
void runAny(base)
void runAny(rescued)
void runPlain(exploding)
// @ts-expect-error a fallback may succeed with another value
void runPlain(rescued)
// @ts-expect-error a bound policy runs no other function
void runAny(call)
// any policy, bound or not, can be inspected and extended, not run
const describeAny = (policy: AnyPolicy): string[] => policy.with(new Counter()).describe()
describeAny(call)
// @ts-expect-error it may be bound
const runAnyPolicy = (policy: AnyPolicy): Promise<unknown> => policy.execute(fetchUser)
void runAnyPolicy

// a generic wrapper returns the value of fn, Results unwrapped
const withBase = async <T>(fn: () => Promise<T>): Promise<ValueOfReturn<Awaited<T>>> =>
  base.execute(fn)
const wrapped = await withBase(findUser)
expectType<Equal<typeof wrapped, User>>()
// @ts-expect-error a Result returned by fn is unwrapped: T is not the value
const wrongWrapper = async <T>(fn: () => Promise<T>): Promise<T> => base.execute(fn)
void wrongWrapper
