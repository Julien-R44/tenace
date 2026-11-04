import type { Temporal } from 'temporal-polyfill'

import type { Duration } from '../duration.ts'

/**
 * A deadline returned by `clock.timeout`. Its signal aborts with a
 * `TimeoutError` once the duration passes. Hold it with `using` for
 * the block it bounds, or end it with `[Symbol.dispose]()`.
 */
export type Deadline = { signal: AbortSignal } & Disposable

/**
 * Options accepted by `clock.until`.
 */
export type UntilOptions = {
  /** How long to keep observing before giving up with `null`. `Infinity` waits until the signal aborts */
  within: Duration
  /**
   * The pause between two observations, 1ms at least, or a function of the 1-based number of
   * observations done so far, such as `backoff.exponential()`
   */
  every: Duration | ((attempt: number) => Duration)
  /** Cancels the poll. Its reason is thrown to the caller */
  signal?: AbortSignal | undefined
}

/**
 * Where a clock reads the time and schedules its timers. The real
 * implementation uses the system clocks and the global timers, the fake
 * one moves only when a test moves it.
 *
 * Both accept delays beyond the 2^31 - 1 ms of the global timers. A
 * delay of `Infinity` never ends, a negative or `NaN` one ends at once.
 */
export interface TimeSource {
  now(): Temporal.Instant
  monotonic(): number
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>
  timeout(milliseconds: number): Deadline
}
