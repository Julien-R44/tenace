/**
 * Opaque timer handle returned by `Clock.setTimeout`.
 */
export type TimerHandle = unknown

/**
 * Source of time for every policy. Injected so policies can be tested with a
 * controllable clock and so state machines stay pure (`now` is an input).
 */
export interface Clock {
  /**
   * Current time in milliseconds since the Unix epoch.
   */
  now(): number
  /**
   * Calls `callback` once after `ms`. `ms` can be larger than the platform timer limit,
   * and a timer of `Infinity` never fires.
   */
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

type NativeTimer = ReturnType<typeof globalThis.setTimeout>

/**
 * Longest delay of the global timers: longer ones fire after ~1ms.
 */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Handle of a delay longer than `MAX_TIMER_MS`, chained in chunks. Holds no timer for
 * `Infinity`.
 */
class LongTimer {
  current: NativeTimer | undefined
}

function setLongTimeout(callback: () => void, ms: number): LongTimer {
  const timer = new LongTimer()
  if (ms === Number.POSITIVE_INFINITY) return timer

  const schedule = (remaining: number): void => {
    const chunk = Math.min(remaining, MAX_TIMER_MS)
    timer.current = globalThis.setTimeout(
      () => (remaining > chunk ? schedule(remaining - chunk) : callback()),
      chunk,
    )
  }
  schedule(ms)
  return timer
}

/**
 * Real clock, backed by `Date.now()` and the global timers.
 */
export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number): TimerHandle =>
    ms > MAX_TIMER_MS ? setLongTimeout(callback, ms) : globalThis.setTimeout(callback, ms),
  clearTimeout: (handle: TimerHandle): void => {
    const timer = handle instanceof LongTimer ? handle.current : (handle as NativeTimer)
    globalThis.clearTimeout(timer)
  },
})
