import type { Temporal } from 'temporal-polyfill'

import type { Duration } from '../duration.ts'

/**
 * A deadline returned by `clock.timeout`. Its signal aborts with a
 * `TimeoutError` once the duration passes. Hold it with `using` for
 * the block it bounds, or end it with `[Symbol.dispose]()`.
 */
export type Deadline = { signal: AbortSignal } & Disposable

/**
 * Options accepted by `clock.waitFor` and `clock.poll`.
 */
export type WaitForOptions = {
  /** Total time budget, including observations. Defaults to 10 seconds. `Infinity` disables it */
  timeout?: Duration | undefined
  /**
   * The pause between two observations, 1ms at least, or a function of the 1-based number of
   * observations done so far, such as `backoff.exponential()`. Defaults to 100ms
   */
  interval?: Duration | ((attempt: number) => Duration) | undefined
  /** Cancels the operation with a `CancelledError` preserving the reason as its cause */
  signal?: AbortSignal | undefined
}

/**
 * Options accepted by `clock.poll`. The predicate receives the unwrapped observation.
 */
export type PollOptions<T> = WaitForOptions & {
  until: (value: T) => boolean | PromiseLike<boolean>
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
