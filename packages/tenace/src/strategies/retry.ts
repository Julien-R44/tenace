import type { ExecutionContext } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { sleep, yieldToEventLoop } from '../internal/sleep.ts'
import type { AnyResult } from '../result/core.ts'
import { type Next, Strategy } from '../strategy.ts'
import type { TagOf } from '../types.ts'
import { backoff } from '../backoff.ts'
import type { RetryBudget } from './retry_budget.ts'

/**
 * Why an attempt is retried with `retryIfValue`: the error it failed with, or the value
 * `retryIfValue` rejected. Tell them apart with `'value' in cause`.
 */
export type RetryCause<E, V> =
  | { readonly error: E }
  | { readonly value: V; readonly error?: undefined }

/**
 * Passed to `onRetry`. Without `retryIfValue` (`V = never`), always about an error.
 */
export type RetryEvent<E, V = never> = {
  /**
   * The 1-based attempt that is retried.
   */
  readonly attempt: number
  /**
   * Delay before the next attempt.
   */
  readonly delayMs: number
} & ([V] extends [never] ? { readonly error: E } : RetryCause<E, V>)

interface BaseRetryOptions<E> {
  /**
   * Retries after the first attempt: `retries: 2` means at most 3 attempts.
   */
  readonly retries: number
  /**
   * Only retry errors with these tags. A `CircuitOpenError` is retried only when listed.
   */
  readonly retryOn?: readonly TagOf<E>[] | undefined
  /**
   * Only retry errors for which it returns `true`. Combined with `retryOn`, both must agree.
   */
  readonly retryIf?: ((error: E, attempt: number) => boolean) | undefined
  /**
   * Shared cap on the share of retries. When exhausted, the last result is returned.
   */
  readonly budget?: RetryBudget | undefined
  /**
   * Wait at least `error.retryAfterMs` when the error has one (rate limits, open circuits,
   * HTTP `Retry-After`). Defaults to `true`.
   */
  readonly respectRetryAfter?: boolean | undefined
  /**
   * Upper bound of the delay before a retry, `retryAfterMs` included. Defaults to no bound.
   */
  readonly maxDelay?: Duration | undefined
  /**
   * Overrides the execution `idempotent` option. When `false`, only calls rejected before
   * running (full bulkhead, rate limit, lock, open circuit listed in `retryOn`) are retried,
   * never values.
   */
  readonly idempotent?: boolean | undefined
}

export interface RetryOptions<E = unknown> extends BaseRetryOptions<E> {
  /**
   * Delay before each retry: a fixed duration, a backoff preset, or a function of the
   * failed attempt and its error. Defaults to `backoff.exponential()` (100ms base, x2,
   * 30s max, full jitter). An `Infinity` delay (or `retryAfterMs`) stops retrying unless
   * `maxDelay` caps it, and returns the error, with a `retry.declined` event.
   */
  readonly delay?: Duration | ((attempt: number, error: E) => Duration) | undefined
  /**
   * Called before waiting for the next attempt.
   */
  readonly onRetry?: ((event: RetryEvent<E>) => void) | undefined
  readonly retryIfValue?: undefined
}

/**
 * Retry options that also retry successful values (`retryIfValue`). `delay` and `onRetry`
 * then see the cause of each retry: `{ error }` or `{ value }`.
 */
export interface ValueRetryOptions<E = unknown, V = unknown> extends BaseRetryOptions<E> {
  /**
   * Also retry successful values for which it returns `true`, such as a `503` response that
   * did not throw. Once retries are exhausted, the last value is returned as a success.
   * Values never go through `retryOn` / `retryIf`, which only see errors.
   */
  readonly retryIfValue: (value: V, attempt: number) => boolean
  /**
   * Like `RetryOptions.delay`, with the cause of the retry instead of the error.
   */
  readonly delay?: Duration | ((attempt: number, cause: RetryCause<E, V>) => Duration) | undefined
  /**
   * Called before waiting for the next attempt.
   */
  readonly onRetry?: ((event: RetryEvent<E, V>) => void) | undefined
}

type AnyRetryOptions<E, V> = ValueRetryOptions<E, V> | RetryOptions<E>

/**
 * Options of a `Retry` built on its own: `retryOn` accepts any tag when the errors are unknown.
 */
type Standalone<O, E> = unknown extends E
  ? Omit<O, 'retryOn'> & { readonly retryOn?: readonly string[] | undefined }
  : O

const NOT_RUN_TAGS: ReadonlySet<unknown> = new Set([
  'CircuitOpenError',
  'BulkheadFullError',
  'RateLimitError',
  'LockNotAcquiredError',
])

const defaultDelay = backoff.exponential()

/**
 * Retries without delay run on microtasks only, and would starve the event loop (and the
 * timeout of the caller) if the function fails synchronously. Every so many of them, the
 * retry yields to the event loop.
 */
const IMMEDIATE_RETRIES_PER_YIELD = 100

/**
 * Retries the inner steps when they fail, or when `retryIfValue` rejects their value. Stops
 * on an accepted result, when retries are exhausted, when the cause is not retryable, or as
 * soon as the signal aborts. Returns the last result. A `CircuitOpenError` is not retryable
 * unless `retryOn` lists it: retrying an open circuit only waits for it.
 *
 * The inner steps see the attempt number (1-based) in their context. Callbacks must not
 * throw: a throw is a bug and rejects the execution with the thrown value.
 */
export class Retry<E = unknown, V = unknown> extends Strategy {
  readonly name = 'retry'
  readonly retries: number
  readonly #options: AnyRetryOptions<E, V>
  readonly #fixedDelay: number | undefined
  readonly #maxDelay: number

  constructor(options: Standalone<ValueRetryOptions<E, V>, E>)
  constructor(options: Standalone<RetryOptions<E>, E>)
  constructor(options: Standalone<AnyRetryOptions<E, V>, E>) {
    super()
    const { retries } = options
    if (!(retries === Number.POSITIVE_INFINITY || (Number.isInteger(retries) && retries >= 0))) {
      throw new RangeError(`Invalid retries: ${retries}. Expected a non-negative integer`)
    }
    this.retries = retries
    this.#options = options as AnyRetryOptions<E, V>
    this.#fixedDelay =
      typeof options.delay === 'function' || options.delay === undefined
        ? undefined
        : toMs(options.delay)
    this.#maxDelay =
      options.maxDelay === undefined ? Number.POSITIVE_INFINITY : toMs(options.maxDelay)
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    this.#options.budget?.recordExecution(context.clock)

    let immediateRetries = 0
    for (let attempt = 1; ; attempt++) {
      const result = await next(context.with({ attempt }))
      if (context.signal.aborted) return result
      const cause = this.#causeOf(result, attempt)
      if (!cause) return result
      if (attempt > this.retries) {
        if (this.retries > 0) context.emit({ type: 'retry.exhausted', attempts: attempt, ...cause })
        return result
      }

      const idempotent = this.#options.idempotent ?? context.idempotent
      const notRun = !result.ok && NOT_RUN_TAGS.has((result.error as { _tag?: unknown })?._tag)
      if (!idempotent && !notRun) {
        context.emit({ type: 'retry.declined', attempt, reason: 'idempotency', ...cause })
        return result
      }
      const delayMs = this.#delayFor(cause, attempt)
      if (delayMs === Number.POSITIVE_INFINITY) {
        context.emit({ type: 'retry.declined', attempt, reason: 'delay', ...cause })
        return result
      }
      if (this.#options.budget && !this.#options.budget.tryAcquire(context.clock)) {
        context.emit({ type: 'retry.declined', attempt, reason: 'budget', ...cause })
        return result
      }

      ;(this.#options.onRetry as ((event: RetryEvent<E, V>) => void) | undefined)?.({
        attempt,
        delayMs,
        ...cause,
      } as RetryEvent<E, V>)
      context.emit({ type: 'retry.scheduled', attempt, delayMs, ...cause })

      if (delayMs > 0) {
        immediateRetries = 0
        const waited = await sleep(context.clock, delayMs, context.signal)
        if (!waited) return result
      } else {
        if (++immediateRetries % IMMEDIATE_RETRIES_PER_YIELD === 0) await yieldToEventLoop()
        if (context.signal.aborted) return result
      }
    }
  }

  /**
   * Why `result` should be retried, if it should.
   */
  #causeOf(result: AnyResult, attempt: number): RetryCause<E, V> | undefined {
    if (result.ok) {
      const { retryIfValue } = this.#options
      const value = result.value as V
      return retryIfValue?.(value, attempt) ? { value } : undefined
    }
    const error = result.error as E
    return this.#isRetryable(error, attempt) ? { error } : undefined
  }

  #isRetryable(error: E, attempt: number): boolean {
    const { retryOn, retryIf } = this.#options
    const tag = (error as { _tag?: unknown } | null)?._tag as TagOf<E>
    if (retryOn ? !retryOn.includes(tag) : tag === 'CircuitOpenError') return false
    return !retryIf || retryIf(error, attempt)
  }

  #delayFor(cause: RetryCause<E, V>, attempt: number): number {
    const { delay } = this.#options
    let delayMs =
      this.#fixedDelay ??
      (typeof delay === 'function'
        ? toMs(
            this.#options.retryIfValue
              ? (delay as (attempt: number, cause: RetryCause<E, V>) => Duration)(attempt, cause)
              : (delay as (attempt: number, error: E) => Duration)(attempt, cause.error as E),
          )
        : defaultDelay(attempt))

    if (this.#options.respectRetryAfter !== false && 'error' in cause) {
      const retryAfterMs = (cause.error as { retryAfterMs?: unknown } | null)?.retryAfterMs
      if (typeof retryAfterMs === 'number' && retryAfterMs > delayMs) delayMs = retryAfterMs
    }
    return Math.min(delayMs, this.#maxDelay)
  }
}
