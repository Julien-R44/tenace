import { Batch, type BatchOptions, mapTasks } from './batch.ts'
import type { Context } from './context.ts'
import type { ErrorOfReturn, Fold, OtherError, ValueOfReturn } from './fold.ts'
import { combine, type Instrumentation } from './instrumentation.ts'
import {
  overrideGlobalChaos,
  overrideGlobalInstrumentation,
} from './internal/global_instrumentation.ts'
import { Chaos, type ChaosOptions } from './strategies/chaos.ts'
import { type Fn, Policy, type PolicyOptions, type ReusablePolicy } from './policy.ts'
import type { Result } from './result/core.ts'
import type { AnyOp } from './strategy.ts'
import { waitFor } from './wait_for.ts'

type DefaultPolicy = Policy<[], never, OtherError>
type OpsOf<P> = P extends Policy<infer Ops, unknown, unknown, undefined> ? Ops : []
type ValueOf<P> = P extends Policy<readonly AnyOp[], infer TAdd, unknown, undefined> ? TAdd : never
type TaskValue<F, P> = F extends Fn ? ValueOfReturn<Awaited<ReturnType<F>>> | ValueOf<P> : never
type TaskResult<F, P> = F extends Fn
  ? Result<TaskValue<F, P>, Fold<ErrorOfReturn<Awaited<ReturnType<F>>>, OpsOf<P>>>
  : never
type MapValue<R, P> = ValueOfReturn<Awaited<R>> | ValueOf<P>
type MapResult<R, P> = Result<MapValue<R, P>, Fold<ErrorOfReturn<Awaited<R>>, OpsOf<P>>>

export interface TenaceEntry {
  /**
   * A reusable policy, to run any function with `.execute(fn)` / `.settle(fn)`.
   *
   * `E` declares the errors functions may return as `Result.err(...)`, so callbacks
   * (`retryIf`, fallbacks...) can inspect them. Undeclared errors still flow through and
   * are exact in the final Result type; callbacks see them as an opaque `OtherError`.
   */
  policy<E = never>(options?: PolicyOptions): Policy<[], never, E | OtherError>

  /**
   * An inline policy bound to `fn`: callbacks see the exact errors of `fn`.
   * Run it with `.execute()` / `.settle()`.
   */
  call<F extends Fn>(
    fn: F,
    options?: PolicyOptions,
  ): Policy<[], never, ErrorOfReturn<Awaited<ReturnType<F>>>, F>

  /**
   * Runs functions through a policy with bounded concurrency. `.execute()` resolves with
   * the values in order (fail-fast), `.settle()` with one typed Result per function.
   *
   * ```ts
   * const [user, posts] = await Tenace.all([() => getUser(id), () => getPosts(id)], { policy }).execute()
   * ```
   */
  all<const F extends readonly Fn[], P extends ReusablePolicy = DefaultPolicy>(
    tasks: F,
    options?: BatchOptions<P>,
  ): Batch<
    { -readonly [K in keyof F]: TaskValue<F[K], P> },
    { -readonly [K in keyof F]: TaskResult<F[K], P> }
  >

  /**
   * Runs `fn` for each item through a policy with bounded concurrency.
   *
   * ```ts
   * const users = await Tenace.map(ids, id => getUser(id), { policy, concurrency: 5 }).execute()
   * ```
   */
  map<T, R, P extends ReusablePolicy = DefaultPolicy>(
    items: Iterable<T>,
    fn: (item: T, context: Context, index: number) => R,
    options?: BatchOptions<P>,
  ): Batch<MapValue<R, P>[], MapResult<R, P>[]>

  /**
   * Sets the default instrumentation of every policy (several are combined). Returns a
   * function removing this setting: the default is the latest setting not removed yet, so
   * restore functions can be called in any order.
   *
   * ```ts
   * Tenace.instrument(openTelemetry({ tracer, meter }))
   * ```
   */
  instrument(...instrumentations: Instrumentation[]): () => void

  /**
   * Injects faults around every function call of every policy, for tests and game days.
   * Injected errors are thrown errors (`UnexpectedError`), so types stay accurate. Returns a
   * function removing this setting, like `Tenace.instrument()`.
   *
   * ```ts
   * const restore = Tenace.chaos({ rate: 0.5, latency: '200ms' })
   * ```
   */
  chaos(options: Omit<ChaosOptions, 'error' | 'value'>): () => void

  /**
   * Calls `condition` until it returns `true`. Rejects with a `TimeoutError` after
   * `timeout` (`10s` by default). Same as the `waitFor` export.
   *
   * ```ts
   * await Tenace.waitFor(() => queue.isEmpty(), { interval: '200ms', timeout: '5s' })
   * ```
   */
  waitFor: typeof waitFor
}

export const Tenace: TenaceEntry = Object.freeze({
  policy: <E = never>(options?: PolicyOptions): Policy<[], never, E | OtherError> =>
    new Policy([], undefined, options),
  call: <F extends Fn>(
    fn: F,
    options?: PolicyOptions,
  ): Policy<[], never, ErrorOfReturn<Awaited<ReturnType<F>>>, F> => {
    if (typeof fn !== 'function') throw new TypeError('Tenace.call(fn) expects a function')
    return new Policy([], fn, options)
  },
  all: (tasks: readonly Fn[], options: BatchOptions<ReusablePolicy> = {}): Batch<never, never> =>
    new Batch(
      tasks,
      options.policy ?? new Policy(),
      options.concurrency ?? Number.POSITIVE_INFINITY,
    ),
  map: <T>(
    items: Iterable<T>,
    fn: (item: T, context: Context, index: number) => unknown,
    options: BatchOptions<ReusablePolicy> = {},
  ): Batch<never, never> =>
    new Batch(
      mapTasks(items, fn),
      options.policy ?? new Policy(),
      options.concurrency ?? Number.POSITIVE_INFINITY,
    ),
  chaos: (options: Omit<ChaosOptions, 'error' | 'value'>): (() => void) =>
    overrideGlobalChaos(new Chaos(options) as never),
  instrument: (...instrumentations: Instrumentation[]): (() => void) =>
    overrideGlobalInstrumentation(
      instrumentations.length === 0 ? undefined : combine(...instrumentations),
    ),
  waitFor,
})
