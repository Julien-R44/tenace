import { type Duration, toMs } from './duration.ts'

/**
 * Computes the delay (ms) before the next attempt. `attempt` is the 1-based attempt that
 * just failed.
 */
export type BackoffFn = (attempt: number) => number

/**
 * - `full`: random delay in `[0, computed]` (best to spread retries of many clients).
 * - `equal`: `computed / 2` plus a random half.
 * - `none`: exactly the computed delay.
 */
export type Jitter = 'full' | 'equal' | 'none'

export interface ExponentialBackoffOptions {
  /**
   * Delay after the first failed attempt. Defaults to `100ms`.
   */
  readonly base?: Duration
  /**
   * Multiplier between attempts, a finite number >= 1. Defaults to `2`.
   */
  readonly factor?: number
  /**
   * Upper bound, applied before jitter. Defaults to `30s`.
   */
  readonly max?: Duration
  /**
   * Defaults to `full`.
   */
  readonly jitter?: Jitter
  /**
   * Source of randomness in `[0, 1)`, for tests. Defaults to `Math.random`.
   */
  readonly random?: () => number
}

export interface LinearBackoffOptions {
  /**
   * Delay after the first failed attempt, added again at each attempt. Defaults to `100ms`.
   */
  readonly base?: Duration
  /**
   * Upper bound, applied before jitter. Defaults to `30s`.
   */
  readonly max?: Duration
  /**
   * Defaults to `none`.
   */
  readonly jitter?: Jitter
  readonly random?: () => number
}

function applyJitter(delay: number, jitter: Jitter, random: () => number): number {
  if (delay === Number.POSITIVE_INFINITY) return delay
  if (jitter === 'full') return Math.round(delay * random())
  if (jitter === 'equal') return Math.round(delay / 2 + (delay / 2) * random())
  return delay
}

/**
 * Backoff presets for `withRetry({ delay })`.
 *
 * ```ts
 * .withRetry({ retries: 5, delay: backoff.exponential({ base: '200ms', max: '10s' }) })
 * ```
 */
export const backoff: {
  constant(delay: Duration): BackoffFn
  linear(options?: LinearBackoffOptions): BackoffFn
  exponential(options?: ExponentialBackoffOptions): BackoffFn
} = Object.freeze({
  constant(delay: Duration): BackoffFn {
    const ms = toMs(delay)
    return () => ms
  },

  linear(options: LinearBackoffOptions = {}): BackoffFn {
    const base = toMs(options.base ?? 100)
    const max = toMs(options.max ?? '30s')
    const jitter = options.jitter ?? 'none'
    const random = options.random ?? Math.random
    return attempt => applyJitter(Math.min(base * attempt, max), jitter, random)
  },

  exponential(options: ExponentialBackoffOptions = {}): BackoffFn {
    const base = toMs(options.base ?? 100)
    const factor = options.factor ?? 2
    const max = toMs(options.max ?? '30s')
    const jitter = options.jitter ?? 'full'
    const random = options.random ?? Math.random
    if (!(factor >= 1 && Number.isFinite(factor))) {
      throw new RangeError(`Invalid backoff factor: ${factor}. Expected a finite number >= 1`)
    }
    if (base === 0) return () => 0
    return attempt => applyJitter(Math.min(base * factor ** (attempt - 1), max), jitter, random)
  },
})
