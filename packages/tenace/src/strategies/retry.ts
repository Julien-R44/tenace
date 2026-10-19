import type { ExecutionContext } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { sleep } from '../internal/sleep.ts'
import type { AnyResult } from '../result.ts'
import { type Next, Strategy } from '../strategy.ts'
import type { TagOf } from '../types.ts'
import { backoff } from '../backoff.ts'
import type { RetryBudget } from './retry_budget.ts'

export interface RetryEvent<E> {
  /**
   * The 1-based attempt that just failed.
   */
  readonly attempt: number
  readonly error: E
  /**
   * Delay before the next attempt.
   */
  readonly delayMs: number
}

export interface RetryOptions<E = unknown> {
  /**
   * Retries after the first attempt: `retries: 2` means at most 3 attempts.
   */
  readonly retries: number
  /**
   * Delay before each retry: a fixed duration, a backoff preset, or a function of the
   * failed attempt and its error. Defaults to `backoff.exponential()` (100ms base, x2,
   * 30s max, full jitter). An `Infinity` delay (or `retryAfterMs`) stops retrying and
   * returns the error, with a `retry.declined` event.
   */
  readonly delay?: Duration | ((attempt: number, error: E) => Duration)
  /**
   * Only retry errors with these tags.
   */
  readonly retryOn?: readonly TagOf<E>[]
  /**
   * Only retry errors for which it returns `true`. Combined with `retryOn`, both must agree.
   */
  readonly retryIf?: (error: E, attempt: number) => boolean
  /**
   * Called before waiting for the next attempt.
   */
  readonly onRetry?: (event: RetryEvent<E>) => void
  /**
   * Shared cap on the share of retries. When exhausted, the last error is returned.
   */
  readonly budget?: RetryBudget
  /**
   * Wait at least `error.retryAfterMs` when the error has one (rate limits, open circuits,
   * HTTP `Retry-After`). Defaults to `true`.
   */
  readonly respectRetryAfter?: boolean
  /**
   * Upper bound of the delay before a retry, `retryAfterMs` included. Defaults to no bound.
   */
  readonly maxDelay?: Duration
  /**
   * Overrides the execution `idempotent` option. When `false`, only calls rejected before
   * running (open circuit, full bulkhead, rate limit, lock) are retried.
   */
  readonly idempotent?: boolean
}

/**
 * Options of a `Retry` built on its own: `retryOn` accepts any tag when the errors are unknown.
 */
type StandaloneRetryOptions<E> = unknown extends E
  ? Omit<RetryOptions<E>, 'retryOn'> & { readonly retryOn?: readonly string[] }
  : RetryOptions<E>

const NOT_RUN_TAGS: ReadonlySet<unknown> = new Set([
  'CircuitOpenError',
  'BulkheadFullError',
  'RateLimitError',
  'LockNotAcquiredError',
])

const defaultDelay = backoff.exponential()

/**
 * Retries the inner steps when they fail. Stops on success, when retries are exhausted,
 * when the error is not retryable, or as soon as the signal aborts. Returns the last error.
 *
 * The inner steps see the attempt number (1-based) in their context. Callbacks must not
 * throw: a throw is a bug and rejects the execution with the thrown value.
 */
export class Retry<E = unknown> extends Strategy {
  readonly name = 'retry'
  readonly retries: number
  readonly #options: RetryOptions<E>
  readonly #fixedDelay: number | undefined
  readonly #maxDelay: number

  constructor(options: StandaloneRetryOptions<E>) {
    super()
    const { retries } = options
    if (!(retries === Number.POSITIVE_INFINITY || (Number.isInteger(retries) && retries >= 0))) {
      throw new RangeError(`Invalid retries: ${retries}. Expected a non-negative integer`)
    }
    this.retries = retries
    this.#options = options as RetryOptions<E>
    this.#fixedDelay =
      typeof options.delay === 'function' || options.delay === undefined
        ? undefined
        : toMs(options.delay)
    this.#maxDelay =
      options.maxDelay === undefined ? Number.POSITIVE_INFINITY : toMs(options.maxDelay)
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    this.#options.budget?.recordExecution(context.clock)

    for (let attempt = 1; ; attempt++) {
      const result = await next(context.with({ attempt }))
      if (result.ok || context.signal.aborted) return result
      if (attempt > this.retries) {
        if (this.retries > 0)
          context.emit({ type: 'retry.exhausted', attempts: attempt, error: result.error })
        return result
      }

      const error = result.error as E
      if (!this.#isRetryable(error, attempt)) return result
      const idempotent = this.#options.idempotent ?? context.idempotent
      if (!idempotent && !NOT_RUN_TAGS.has((error as { _tag?: unknown } | null)?._tag)) {
        context.emit({ type: 'retry.declined', attempt, error, reason: 'idempotency' })
        return result
      }
      const delayMs = this.#delayFor(error, attempt)
      if (delayMs === Number.POSITIVE_INFINITY) {
        context.emit({ type: 'retry.declined', attempt, error, reason: 'delay' })
        return result
      }
      if (this.#options.budget && !this.#options.budget.tryAcquire(context.clock)) {
        context.emit({ type: 'retry.declined', attempt, error, reason: 'budget' })
        return result
      }

      this.#options.onRetry?.({ attempt, error, delayMs })
      context.emit({ type: 'retry.scheduled', attempt, delayMs, error })

      const waited = await sleep(context.clock, delayMs, context.signal)
      if (!waited) return result
    }
  }

  #isRetryable(error: E, attempt: number): boolean {
    const { retryOn, retryIf } = this.#options
    if (retryOn && !retryOn.includes((error as { _tag?: unknown } | null)?._tag as TagOf<E>)) {
      return false
    }
    return !retryIf || retryIf(error, attempt)
  }

  #delayFor(error: E, attempt: number): number {
    const { delay } = this.#options
    let delayMs =
      this.#fixedDelay ??
      (typeof delay === 'function' ? toMs(delay(attempt, error)) : defaultDelay(attempt))

    if (this.#options.respectRetryAfter !== false) {
      const retryAfterMs = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs
      if (typeof retryAfterMs === 'number' && retryAfterMs > delayMs) delayMs = retryAfterMs
    }
    return Math.min(delayMs, this.#maxDelay)
  }
}
