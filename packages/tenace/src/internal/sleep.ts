import type { Clock } from '../clock.ts'

/**
 * Resolves after a task of the global timers, so a loop that never waits on a timer (retries
 * without delay of a function failing synchronously) lets the other timers and I/O run.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, 0))
}

/**
 * Waits `ms` milliseconds on the given clock. Never rejects: resolves `true` when the
 * delay elapsed, `false` as soon as the signal aborts (or immediately if already aborted).
 * `Infinity` only ends with the signal, `NaN` is treated as `0`.
 */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (!(ms > 0)) return Promise.resolve(true)
  if (ms === Number.POSITIVE_INFINITY) {
    return new Promise(resolve =>
      signal?.addEventListener('abort', () => resolve(false), { once: true }),
    )
  }

  return new Promise(resolve => {
    const onAbort = (): void => {
      clock.clearTimeout(handle)
      resolve(false)
    }
    const handle = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
