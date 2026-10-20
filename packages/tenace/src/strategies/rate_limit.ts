import type { Clock } from '../clock.ts'
import type { ExecutionContext } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { RateLimitError, UnexpectedError } from '../errors.ts'
import { sleep } from '../internal/sleep.ts'
import type { MaybePromise } from '../internal/types.ts'
import { type AnyResult, err } from '../result/core.ts'
import { type Next, Strategy } from '../strategy.ts'

export interface RateLimitDecision {
  readonly allowed: boolean
  /**
   * When the next call may be allowed (0 when allowed). A denial without a positive wait
   * is rejected right away, even with `maxWait`.
   */
  readonly retryAfterMs: number
}

/**
 * Where a rate limiter counts calls. Implement it for a distributed limiter, or use the
 * `rate-limiter-flexible` adapter. A failing `consume()` (store down) fails the execution
 * with an `UnexpectedError`.
 */
export interface RateLimitStore {
  consume(key: string, now: number): MaybePromise<RateLimitDecision>
}

interface Bucket {
  tokens: number
  updatedAt: number
}

/**
 * Absorbs float rounding: `561 * (1 / 561)` is `0.9999999999999999`, not `1`.
 */
const EPSILON = 1e-9

/**
 * In-process token bucket: `limit` calls per `per`, refilled continuously, bursts up to
 * `limit`. Keys not used for `per` (full again) are forgotten.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly limit: number
  readonly perMs: number
  /**
   * Least recently used first, so the keys to forget are at the front.
   */
  readonly #buckets = new Map<string, Bucket>()

  constructor(options: { readonly limit: number; readonly per: Duration }) {
    if (!(Number.isInteger(options.limit) && options.limit >= 1)) {
      throw new RangeError(`Invalid limit: ${options.limit}. Expected an integer >= 1`)
    }
    this.limit = options.limit
    this.perMs = toMs(options.per)
    if (!(this.perMs > 0 && Number.isFinite(this.perMs))) {
      throw new RangeError(`Invalid per: ${this.perMs}ms`)
    }
  }

  /**
   * Keys currently tracked.
   */
  get size(): number {
    return this.#buckets.size
  }

  consume(key: string, now: number): RateLimitDecision {
    const bucket = this.#buckets.get(key) ?? { tokens: this.limit, updatedAt: now }
    const elapsed = Math.max(0, now - bucket.updatedAt)
    bucket.tokens = Math.min(this.limit, bucket.tokens + (elapsed * this.limit) / this.perMs)
    bucket.updatedAt = now
    this.#buckets.delete(key)
    this.#buckets.set(key, bucket)
    this.#forgetIdle(now)

    if (bucket.tokens >= 1 - EPSILON) {
      bucket.tokens = Math.max(0, bucket.tokens - 1)
      return { allowed: true, retryAfterMs: 0 }
    }
    return {
      allowed: false,
      retryAfterMs: Math.ceil(((1 - bucket.tokens) * this.perMs) / this.limit),
    }
  }

  /**
   * Forgets the least recently used buckets that are full again, untouched for `per`.
   * Each bucket is forgotten at most once per use: O(1) amortized.
   */
  #forgetIdle(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedAt < this.perMs) return
      this.#buckets.delete(key)
    }
  }
}

export type RateLimitOptions = (
  | { readonly limit: number; readonly per: Duration; readonly store?: undefined }
  | { readonly store: RateLimitStore }
) & {
  /**
   * Key to count calls against. Defaults to the execution key, then `default`.
   */
  readonly key?: string | undefined
  /**
   * Wait for a slot instead of rejecting, when the wait is at most this long. Defaults to
   * `0` (reject right away).
   */
  readonly maxWait?: Duration | undefined
  /**
   * Clock passed to the store. Defaults to the clock of the execution.
   */
  readonly clock?: Clock | undefined
}

/**
 * Limits the call rate. Adds `RateLimitError` (with `retryAfterMs`) to the error channel.
 * Share the instance (or the store) to share the limit. A store failure becomes an
 * `UnexpectedError`.
 *
 * ```ts
 * const limit = new RateLimit({ limit: 10, per: '1s' })
 * ```
 */
export class RateLimit extends Strategy<RateLimitError> {
  readonly name = 'rateLimit'
  readonly #store: RateLimitStore
  readonly #key: string | undefined
  readonly #maxWaitMs: number
  readonly #clock: Clock | undefined

  constructor(options: RateLimitOptions) {
    super()
    this.#store =
      options.store ?? new MemoryRateLimitStore({ limit: options.limit, per: options.per })
    this.#key = options.key
    this.#maxWaitMs = toMs(options.maxWait ?? 0)
    this.#clock = options.clock
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    const key = this.#key ?? context.key ?? 'default'
    const clock = this.#clock ?? context.clock
    const deadline = clock.now() + this.#maxWaitMs

    for (;;) {
      let decision: RateLimitDecision
      try {
        decision = await this.#store.consume(key, clock.now())
      } catch (error) {
        return err(new UnexpectedError(error))
      }
      if (decision.allowed) return next(context)

      // a denial without a positive wait cannot be waited on: asking again right away spins
      const retryAfterMs = decision.retryAfterMs > 0 ? decision.retryAfterMs : undefined
      if (
        retryAfterMs === undefined ||
        this.#maxWaitMs <= 0 ||
        clock.now() + retryAfterMs > deadline
      ) {
        context.emit({ type: 'rate_limit.rejected', key, retryAfterMs })
        return err(new RateLimitError(key, retryAfterMs))
      }
      if (!(await sleep(clock, retryAfterMs, context.signal))) {
        return err(new UnexpectedError(context.signal.reason))
      }
    }
  }
}
