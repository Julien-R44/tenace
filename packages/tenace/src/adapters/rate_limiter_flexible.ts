import type { RateLimitDecision, RateLimitStore } from '../strategies/rate_limit.ts'

/**
 * The part of a `rate-limiter-flexible` limiter Tenace uses (no runtime import).
 */
export interface RateLimiterFlexibleLike {
  consume(key: string, points?: number): Promise<unknown>
}

function isRejection(value: unknown): value is { msBeforeNext: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    typeof (value as { msBeforeNext?: unknown }).msBeforeNext === 'number'
  )
}

/**
 * Uses a `rate-limiter-flexible` limiter (memory, Redis, Postgres...) as rate limit store.
 *
 * ```ts
 * import { RateLimiterRedis } from 'rate-limiter-flexible'
 * import { rateLimiterFlexible } from '@julr/tenace/adapters/rate-limiter-flexible'
 *
 * const limit = new RateLimit({ store: rateLimiterFlexible(new RateLimiterRedis({ ... })) })
 * ```
 *
 * Store failures (the limiter rejected with an `Error`) reject: the execution fails with
 * that error as an `UnexpectedError`.
 */
export function rateLimiterFlexible(limiter: RateLimiterFlexibleLike): RateLimitStore {
  return {
    async consume(key: string): Promise<RateLimitDecision> {
      try {
        await limiter.consume(key, 1)
        return { allowed: true, retryAfterMs: 0 }
      } catch (error) {
        if (isRejection(error))
          return { allowed: false, retryAfterMs: Math.max(0, error.msBeforeNext) }
        throw error
      }
    },
  }
}
