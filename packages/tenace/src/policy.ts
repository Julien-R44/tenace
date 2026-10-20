import type { Clock } from './clock.ts'
import { type Context, ExecutionContext } from './context.ts'
import type { Duration } from './duration.ts'
import {
  type BulkheadFullError,
  type CircuitOpenError,
  type LockNotAcquiredError,
  type RateLimitError,
  type TimeoutError,
  UnexpectedError,
} from './errors.ts'
import type {
  ErrorOfReturn,
  Fold,
  GuardedTags,
  HandlerError,
  OtherError,
  ValueOfReturn,
} from './fold.ts'
import { type AnyResult, err, type Result } from './result/core.ts'
import { toResult } from './result/registry.ts'
import { combine, type Attributes, type Instrumentation, withoutGlobal } from './instrumentation.ts'
import { guardInstrumentation } from './internal/core_instrumentation.ts'
import { diagnosticsChannel } from './internal/diagnostics_channel.ts'
import { getGlobalChaos, getGlobalInstrumentation } from './internal/global_instrumentation.ts'
import { raceAbort } from './internal/race_signal.ts'
import {
  type AnyOp,
  type AnyStrategy,
  isStrategy,
  type Next,
  type Op,
  type Strategy,
} from './strategy.ts'
import type { ByTag, TagOf } from './types.ts'
import { Bulkhead, type BulkheadOptions } from './strategies/bulkhead.ts'
import { Chaos, type ChaosOptions } from './strategies/chaos.ts'
import { Cache, type CacheOptions } from './strategies/cache.ts'
import { Dedupe, type DedupeOptions } from './strategies/dedupe.ts'
import { Lock, type LockOptions } from './strategies/lock.ts'
import { RateLimit, type RateLimitOptions } from './strategies/rate_limit.ts'
import { StaleFallback, type StaleFallbackOptions } from './strategies/stale_fallback.ts'
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
} from './strategies/circuit_breaker/circuit_breaker.ts'
import { byTags, Fallback, MapError } from './strategies/fallback.ts'
import { Retry, type RetryOptions, type ValueRetryOptions } from './strategies/retry.ts'
import { Timeout, type TimeoutOptions } from './strategies/timeout.ts'

/**
 * A function a policy can run. Receives the attempt context (signal, attempt number).
 */
export type Fn = (context: Context) => unknown

type Returned<F extends Fn> = Awaited<ReturnType<F>>

export interface ExecuteOptions {
  /**
   * Aborting it stops the execution right away: the promise rejects with `signal.reason`
   * (like `fetch`), outside of the typed error channel.
   */
  readonly signal?: AbortSignal | undefined
  /**
   * Clock used by time-based strategies of this execution. Defaults to the system clock.
   * Mostly useful with `TestClock` from `@julr/tenace/testing`.
   */
  readonly clock?: Clock | undefined
  /**
   * Operation name reported to instrumentation. Overrides the policy name.
   */
  readonly name?: string | undefined
  /**
   * Key of this execution, used by dedupe, cache, locks and rate limits that do not set
   * their own: `execute(() => getUser(id), { key: `user:${id}` })`.
   */
  readonly key?: string | undefined
  /**
   * Set to `false` when running the function twice is not safe (payments, emails...).
   * Retries then only retry calls that were rejected before running (full bulkhead, rate
   * limit, lock, open circuit listed in `retryOn`) and emit `retry.declined` for the others.
   * Defaults to `true`.
   */
  readonly idempotent?: boolean | undefined
  /**
   * Extra attributes reported to instrumentation (low cardinality).
   */
  readonly attributes?: Attributes | undefined
}

export interface PolicyOptions {
  /**
   * Operation name reported to instrumentation. Defaults to `tenace`.
   */
  readonly name?: string | undefined
  /**
   * Instrumentation of this policy, added to the one set with `Tenace.instrument()` (the
   * global one wraps it; an instance already in the global one runs once). `false` turns
   * the global one off for this policy. Executions are also published on
   * `node:diagnostics_channel` when it has subscribers.
   *
   * Instrumentation bugs never change the outcome of an execution: errors thrown by its
   * hooks are reported with `globalThis.reportError` (or as uncaught errors), `run` runs the
   * function at most once, and an instrumentation that settles without calling `run` is
   * reported and the execution runs without it.
   */
  readonly instrumentation?: Instrumentation | false | undefined
}

/**
 * Any policy, bound by `Tenace.call(fn)` or not: to store policies, inspect them
 * (`describe()`) or extend them with `.with()`. It may be bound, so it cannot run a
 * function: type a parameter that runs one as `ReusablePolicy`.
 */
export type AnyPolicy = Policy<readonly AnyOp[], unknown, unknown, Fn | undefined>

/**
 * Any reusable policy (`Tenace.policy()`), as a parameter type: it runs any function with
 * `.execute(fn)` / `.settle(fn)` and can be extended (`.withTimeout()`...). Its errors are
 * `unknown`. `V` is what its fallbacks may succeed with: `ReusablePolicy<never>` accepts the
 * policies without fallback values, and `execute(fn)` then resolves with the value of `fn`.
 */
export type ReusablePolicy<V = unknown> = Policy<readonly AnyOp[], V, unknown>

const POLICY_BRAND: unique symbol = Symbol.for('@julr/tenace/policy') as never

/**
 * Whether the value is a policy of any copy of Tenace (`instanceof` fails across
 * duplicated copies of the package).
 */
export function isPolicy(value: unknown): value is AnyPolicy {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[POLICY_BRAND] === true
  )
}

/**
 * A shared strategy instance as is, or a new one created from options.
 */
function strategyOr<S extends AnyStrategy, O>(
  value: NoInfer<S | O>,
  Create: new (options: O) => S,
): S {
  return isStrategy(value) ? (value as S) : new Create(value as O)
}

/**
 * Anything `.with()` accepts: a strategy, or a policy (inlined).
 */
export type Composable = AnyStrategy | ReusablePolicy

type OpsOf<X> =
  X extends Policy<infer Ops, unknown, unknown, undefined>
    ? Ops
    : X extends Strategy<infer Adds, infer Removes, unknown>
      ? [Op<Adds, Removes>]
      : never

type ValuesOf<X> =
  X extends Policy<readonly AnyOp[], infer TAdd, unknown, undefined>
    ? TAdd
    : X extends Strategy<unknown, never, infer Value>
      ? Value
      : never

type BoundValue<Bound> = Bound extends Fn ? ValueOfReturn<Returned<Bound>> : never

/**
 * Values the steps added so far can succeed with: known for a bound call, `unknown` for a
 * reusable policy (its function is not known yet).
 */
type ChainValue<Bound, TAdd> = Bound extends Fn ? BoundValue<Bound> | TAdd : unknown
type BoundError<Bound> = Bound extends Fn ? ErrorOfReturn<Returned<Bound>> : never

/**
 * Errors received by callbacks added at the end of a policy, undeclared ones (`OtherError`)
 * included. Type a predicate shared by callbacks (`retryIf`...) with it.
 */
export type CurrentError<P> =
  P extends Policy<infer Ops, unknown, infer EIn, Fn | undefined>
    ? Fold<EIn | UnexpectedError, Ops>
    : never

/**
 * Errors a policy can produce, without undeclared errors (`OtherError`). Callbacks of a
 * reusable policy also receive `OtherError`: type a predicate passed to them with
 * `CurrentError`.
 */
export type ErrorOf<P> = Exclude<CurrentError<P>, OtherError>

/**
 * Errors `execute()` rejects with as-is: every error but `UnexpectedError` (whose raw cause
 * is rethrown), including undeclared ones (`OtherError`).
 */
export type KnownError<E> = Exclude<E, UnexpectedError>

/**
 * An immutable, composable resilience policy.
 *
 * - `.with(x)` is the single composition operator. `x` is a strategy or another policy.
 *   The first strategy added is the innermost one: `.withTimeout().withRetry()` retries
 *   a timed out attempt.
 * - `.execute(fn)` resolves with the value or rejects. Raw throws of `fn` are rethrown untouched.
 * - `.settle(fn)` resolves with a typed Result and never rejects for errors in the channel.
 *
 * Type parameters, mostly useful in hovers:
 * - `Ops`: what each strategy adds to or removes from the error channel.
 * - `TAdd`: values strategies can produce (fallbacks).
 * - `EIn`: errors callbacks can see before any strategy runs.
 * - `Bound`: the function bound by `Tenace.call(fn)`, if any.
 */
export class Policy<
  out Ops extends readonly AnyOp[],
  out TAdd,
  out EIn,
  Bound extends Fn | undefined = undefined,
> {
  /**
   * Phantom type carrier. Never set at runtime.
   */
  declare readonly __types?: {
    readonly ops: Ops
    readonly value: TAdd
    readonly current: Fold<EIn | UnexpectedError, Ops>
    readonly bound: Bound
  }

  readonly #strategies: readonly AnyStrategy[]
  readonly #bound: Fn | undefined
  readonly #options: PolicyOptions
  readonly #rejected: WeakSet<object> = new WeakSet()

  /**
   * @internal Use `Tenace.policy()` or `Tenace.call(fn)`.
   */
  constructor(strategies: readonly AnyStrategy[] = [], bound?: Fn, options: PolicyOptions = {}) {
    this.#strategies = strategies
    this.#bound = bound
    this.#options = options
  }

  static {
    Object.defineProperty(this.prototype, POLICY_BRAND, { value: true })
  }

  /**
   * Strategies, innermost first.
   */
  get strategies(): readonly AnyStrategy[] {
    return this.#strategies
  }

  /**
   * Adds a strategy, or inlines every strategy of another policy (its errors and fallback
   * values come along). Stateful strategies keep their identity, so their state is shared.
   */
  with<X extends Composable>(x: X): Policy<[...Ops, ...OpsOf<X>], TAdd | ValuesOf<X>, EIn, Bound> {
    const added = isPolicy(x) ? x.strategies : [x as AnyStrategy]
    return new Policy([...this.#strategies, ...added], this.#bound, this.#options)
  }

  /**
   * Bounds the time spent in the steps added before. Sugar for `.with(new Timeout(...))`.
   *
   * ```ts
   * Tenace.policy().withTimeout('500ms').withRetry({ retries: 2 }) // 500ms per attempt
   * Tenace.policy().withRetry({ retries: 2 }).withTimeout('2s') // 2s in total
   * ```
   */
  withTimeout(
    duration: Duration,
    options?: TimeoutOptions,
  ): Policy<[...Ops, Op<TimeoutError, never>], TAdd, EIn, Bound> {
    return this.with(new Timeout(duration, options))
  }

  /**
   * Retries the steps added before when they fail. Callbacks see the errors of the chain
   * so far. Sugar for `.with(new Retry(...))`.
   *
   * ```ts
   * Tenace.policy()
   *   .withTimeout('1s')
   *   .withRetry({ retries: 3, delay: backoff.exponential(), retryOn: ['TimeoutError'] })
   * ```
   */
  withRetry(options: RetryOptions<Fold<EIn | UnexpectedError, Ops>>): Policy<Ops, TAdd, EIn, Bound>
  withRetry(
    options: ValueRetryOptions<Fold<EIn | UnexpectedError, Ops>, ChainValue<Bound, TAdd>>,
  ): Policy<Ops, TAdd, EIn, Bound>
  withRetry(
    options: RetryOptions<never> | ValueRetryOptions<never, never>,
  ): Policy<Ops, TAdd, EIn, Bound> {
    return this.#append(new Retry(options as RetryOptions))
  }

  /**
   * Adds a circuit breaker. Pass a shared `CircuitBreaker` instance to share the circuit
   * between policies, or options to create one for this policy.
   */
  withCircuitBreaker(
    breaker: CircuitBreaker | CircuitBreakerOptions = {},
  ): Policy<[...Ops, Op<CircuitOpenError, never>], TAdd, EIn, Bound> {
    return this.with(strategyOr(breaker, CircuitBreaker))
  }

  /**
   * Limits concurrent calls. Pass a shared `Bulkhead` instance to share the limit between
   * policies, or options to create one for this policy.
   */
  withBulkhead(
    bulkhead: Bulkhead | BulkheadOptions,
  ): Policy<[...Ops, Op<BulkheadFullError, never>], TAdd, EIn, Bound> {
    return this.with(strategyOr(bulkhead, Bulkhead))
  }

  /**
   * Limits the call rate. Pass a shared `RateLimit` instance or options.
   */
  withRateLimit(
    rateLimit: RateLimit | RateLimitOptions,
  ): Policy<[...Ops, Op<RateLimitError, never>], TAdd, EIn, Bound> {
    return this.with(strategyOr(rateLimit, RateLimit))
  }

  /**
   * Runs the steps added before while holding a lock.
   */
  withLock(
    lock: Lock | LockOptions = {},
  ): Policy<[...Ops, Op<LockNotAcquiredError, never>], TAdd, EIn, Bound> {
    return this.with(strategyOr(lock, Lock))
  }

  /**
   * Concurrent executions with the same key share one run (single-flight).
   */
  withDedupe(dedupe: Dedupe | DedupeOptions = {}): Policy<Ops, TAdd, EIn, Bound> {
    return this.#append(strategyOr(dedupe, Dedupe))
  }

  /**
   * Serves the steps added before from a cache (successes only, fail-open).
   */
  withCache(cache: Cache | CacheOptions): Policy<Ops, TAdd, EIn, Bound> {
    return this.#append(strategyOr(cache, Cache))
  }

  /**
   * Serves the last successful value of the key when the steps added before fail.
   */
  withStaleFallback(
    stale: StaleFallback | StaleFallbackOptions = {},
  ): Policy<Ops, TAdd, EIn, Bound> {
    return this.#append(strategyOr(stale, StaleFallback))
  }

  /**
   * Injects faults into the steps added before (testing). An `error` factory adds its
   * error to the channel, a `value` factory adds its value.
   */
  withChaos<E = never, V = never>(
    chaos: Chaos<E, V> | ChaosOptions<E, V> = {},
  ): Policy<[...Ops, Op<E, never>], TAdd | V, EIn, Bound> {
    return this.with(
      isStrategy(chaos) ? (chaos as Chaos<E, V>) : new Chaos(chaos as ChaosOptions<E, V>),
    )
  }

  /**
   * Handles every error of the steps added before. The handler returns a value, `Result.ok()`,
   * `Result.err()` (to fail with another error) or a promise of those. It must not throw.
   *
   * ```ts
   * .withFallback(() => cachedUser) // the error channel is now empty
   * ```
   */
  withFallback<R>(
    handler: (error: Fold<EIn | UnexpectedError, Ops>, context: Context) => R,
  ): Policy<
    [...Ops, Op<HandlerError<Awaited<R>>, unknown>],
    TAdd | ValueOfReturn<Awaited<R>>,
    EIn,
    Bound
  > {
    return this.#append(new Fallback(handler as never))
  }

  /**
   * Handles the errors with the given tags only.
   *
   * ```ts
   * .withFallbackOn(['CircuitOpenError', 'TimeoutError'], () => null)
   * ```
   */
  withFallbackOn<const K extends TagOf<Fold<EIn | UnexpectedError, Ops>>, R>(
    tags: readonly K[],
    handler: (error: ByTag<Fold<EIn | UnexpectedError, Ops>, K>, context: Context) => R,
  ): Policy<
    [...Ops, Op<HandlerError<Awaited<R>>, { readonly _tag: K }>],
    TAdd | ValueOfReturn<Awaited<R>>,
    EIn,
    Bound
  > {
    return this.#append(new Fallback(handler as never, byTags(tags)))
  }

  /**
   * Handles the errors for which `when` returns `true`.
   *
   * - A type guard (on TypeScript >= 5.5, `error => error instanceof NotFound` is inferred as
   *   one) narrows the handler argument and removes the guarded errors from the channel when
   *   they all have a literal `_tag`. The guard must be exact: true for every `X`. A subclass
   *   that adds nothing to its parent is the same type, so a guard on it removes the parent
   *   too: give a guarded subclass its own `_tag` or a member of its own.
   * - A plain predicate handles the errors it matches but removes nothing from the channel.
   *
   * ```ts
   * .withFallbackWhen(error => error instanceof NotFound, () => null) // NotFound is handled
   * .withFallbackWhen(error => error instanceof HttpError && error.status === 404, () => null)
   * ```
   */
  withFallbackWhen<X extends Fold<EIn | UnexpectedError, Ops>, R>(
    when: (error: Fold<EIn | UnexpectedError, Ops>) => error is X,
    handler: (error: X, context: Context) => R,
  ): Policy<
    [...Ops, Op<HandlerError<Awaited<R>>, GuardedTags<X>>],
    TAdd | ValueOfReturn<Awaited<R>>,
    EIn,
    Bound
  >
  withFallbackWhen<R>(
    when: (error: Fold<EIn | UnexpectedError, Ops>) => boolean,
    handler: (error: Fold<EIn | UnexpectedError, Ops>, context: Context) => R,
  ): Policy<
    [...Ops, Op<HandlerError<Awaited<R>>, never>],
    TAdd | ValueOfReturn<Awaited<R>>,
    EIn,
    Bound
  >
  withFallbackWhen(
    when: (error: never) => boolean,
    handler: (error: never, context: Context) => unknown,
  ): AnyPolicy {
    return this.#append(new Fallback(handler, when as (error: unknown) => boolean))
  }

  /**
   * Transforms every error of the steps added before. The mapper must not throw.
   *
   * ```ts
   * .mapError(error => new ServiceUnavailable({ cause: error }))
   * ```
   */
  mapError<E2>(
    mapper: (error: Fold<EIn | UnexpectedError, Ops>) => E2,
  ): Policy<[...Ops, Op<E2, unknown>], TAdd, EIn, Bound> {
    return this.#append(new MapError(mapper as never))
  }

  /**
   * Runs `fn` through the policy. Resolves with its value, or rejects with:
   * - the raw value `fn` threw (never wrapped),
   * - a known error (a `Result.err(...)` returned by `fn`, or one produced by a strategy, like
   *   `TimeoutError`). Narrow it with `policy.isError(error)`,
   * - `signal.reason` when the caller aborts.
   */
  execute<F extends Fn>(
    this: Policy<Ops, TAdd, EIn, undefined>,
    fn: F,
    options?: ExecuteOptions,
  ): Promise<ValueOfReturn<Returned<F>> | TAdd>
  execute(
    this: Policy<Ops, TAdd, EIn, Fn>,
    options?: ExecuteOptions,
  ): Promise<BoundValue<Bound> | TAdd>
  async execute(...args: unknown[]): Promise<unknown> {
    const result = await this.#runWith(args)
    if (result.ok) return result.value
    if (result.error instanceof UnexpectedError) throw result.error.cause
    if (typeof result.error === 'object' && result.error !== null) this.#rejected.add(result.error)
    throw result.error
  }

  /**
   * Runs `fn` through the policy and resolves with a Result whose error type is exact for
   * this function. Never rejects for errors of the channel. Rejects only:
   * - with `signal.reason` when the caller aborts,
   * - on defects: `fn` is not a function, or a strategy or a callback (fallback, mapper,
   *   retry callbacks) threw.
   */
  settle<F extends Fn>(
    this: Policy<Ops, TAdd, EIn, undefined>,
    fn: F,
    options?: ExecuteOptions,
  ): Promise<Result<ValueOfReturn<Returned<F>> | TAdd, Fold<ErrorOfReturn<Returned<F>>, Ops>>>
  settle(
    this: Policy<Ops, TAdd, EIn, Fn>,
    options?: ExecuteOptions,
  ): Promise<Result<BoundValue<Bound> | TAdd, Fold<BoundError<Bound>, Ops>>>
  settle(...args: unknown[]): Promise<AnyResult> {
    return this.#runWith(args)
  }

  /**
   * Whether `error` was rejected by `execute()` of this policy as a known error (a `Result.err()`
   * of the function or an error of a strategy), and not a raw throw. Narrows to the errors
   * of the policy, undeclared ones (`OtherError`) included.
   *
   * Errors are tracked by identity, so:
   * - primitive errors (`Result.err('nope')`) are never recognized, inspect them with `settle()`,
   * - errors rejected by another policy, even one derived from this one, are not recognized,
   * - an object stays recognized once rejected, even if it is later thrown raw (a shared
   *   sentinel error, for instance).
   */
  isError(error: unknown): error is KnownError<Fold<EIn | UnexpectedError, Ops>> {
    return typeof error === 'object' && error !== null && this.#rejected.has(error)
  }

  /**
   * Strategy names, outermost first.
   */
  describe(): string[] {
    return this.#strategies.map(strategy => strategy.name).reverse()
  }

  #append<P>(strategy: AnyStrategy): P {
    return new Policy([...this.#strategies, strategy], this.#bound, this.#options) as P
  }

  #runWith(args: unknown[]): Promise<AnyResult> {
    if (this.#bound) return this.#run(this.#bound, args[0] as ExecuteOptions | undefined)
    if (typeof args[0] !== 'function') {
      return Promise.reject(
        new TypeError('policy.execute(fn) and policy.settle(fn) expect a function'),
      )
    }
    return this.#run(args[0] as Fn, args[1] as ExecuteOptions | undefined)
  }

  async #run(fn: Fn, options: ExecuteOptions | undefined): Promise<AnyResult> {
    const signal = options?.signal
    signal?.throwIfAborted()

    const context = new ExecutionContext({
      signal: signal ?? new AbortController().signal,
      ...(options?.clock && { clock: options.clock }),
      key: options?.key,
      idempotent: options?.idempotent ?? true,
      // nobody holds the controller of the signal created here
      abortable: signal !== undefined,
    })
    const chain = this.#chain(fn)
    // the abort is raced inside the instrumented run, so instrumentations see it
    const start = (inner: ExecutionContext): Promise<AnyResult> =>
      signal ? raceAbort(() => chain(inner), signal) : chain(inner)
    const instrumentation = this.#instrumentation()
    if (!instrumentation) return start(context)
    const observed = (): Promise<AnyResult> =>
      instrumentation.execution(
        {
          name: options?.name ?? this.#options.name ?? 'tenace',
          strategies: this.describe(),
          attributes: options?.attributes ?? {},
        },
        scope => start(context.with({ scope })),
      )
    // raced again outside, so a slow instrumentation never delays the caller abort
    return signal ? raceAbort(observed, signal) : observed()
  }

  /**
   * The instrumentation of this policy (or the global one) plus diagnostics_channel when
   * subscribed, with their contract enforced. `undefined` when nothing observes, so
   * unobserved executions pay nothing.
   */
  #instrumentation(): Instrumentation | undefined {
    const configured = this.#options.instrumentation
    const global = configured === false ? undefined : getGlobalInstrumentation()
    // an instrumentation set globally and on the policy runs once
    const own = configured === false ? undefined : withoutGlobal(configured, global)
    const channel = diagnosticsChannel()
    const observed = channel?.isActive() ? channel : undefined
    if (!global && !own && !observed) return undefined

    const active: Instrumentation[] = []
    for (const instrumentation of [global, own, observed]) {
      if (instrumentation) active.push(guardInstrumentation(instrumentation))
    }
    return active.length === 1 ? active[0] : combine(...active)
  }

  #chain(fn: Fn): Next {
    const chaos = getGlobalChaos()
    const source: Next = chaos
      ? context => chaos.execute(context, inner => runSource(fn, inner))
      : context => runSource(fn, context)
    let next: Next = context =>
      context.observed
        ? context.scope.attempt({ attempt: context.attempt }, () => source(context))
        : source(context)
    for (const strategy of this.#strategies) {
      const inner = next
      next = context => strategy.execute(context, inner)
    }
    return next
  }
}

/**
 * The boundary with user code: never rejects.
 */
async function runSource(fn: Fn, context: ExecutionContext): Promise<AnyResult> {
  try {
    return toResult(await fn(context))
  } catch (thrown) {
    return err(new UnexpectedError(thrown))
  }
}
