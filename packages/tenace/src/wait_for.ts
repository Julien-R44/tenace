import { type Clock, systemClock, type TimerHandle } from './clock.ts'
import type { Context } from './context.ts'
import { type Duration, toMs } from './duration.ts'
import { TimeoutError } from './errors.ts'
import { onAbort } from './internal/race_signal.ts'
import { sleep } from './internal/sleep.ts'

/**
 * Shortest delay between two checks. Without a timer between them, a synchronous condition
 * would loop on microtasks and the timeout would never fire.
 */
const MIN_INTERVAL_MS = 1

export interface WaitForOptions {
  /**
   * Delay between two checks: a duration, or a function of the 1-based number of checks
   * done so far, such as `backoff.exponential()`. Delays under 1ms are rounded up to 1ms.
   * Defaults to `100ms`.
   */
  readonly interval?: Duration | ((attempt: number) => Duration) | undefined
  /**
   * Longest wait, from the call. `Infinity` waits until the signal aborts. Defaults to `10s`.
   */
  readonly timeout?: Duration | undefined
  /**
   * Stops waiting. `waitFor` then rejects with `signal.reason`.
   */
  readonly signal?: AbortSignal | undefined
  /**
   * Clock of the delays and the timeout. Defaults to the system clock.
   */
  readonly clock?: Clock | undefined
}

/**
 * Calls `condition` until it returns `true`, then resolves. The first check runs right
 * away. Rejects with a `TimeoutError` when the timeout elapses, with `signal.reason` when the
 * signal aborts, and with the error of `condition` when it throws.
 *
 * `condition` receives a signal aborted when the wait ends, and the 1-based check number.
 *
 * ```ts
 * await waitFor(async ({ signal }) => (await fetch(healthUrl, { signal })).ok, {
 *   interval: '500ms',
 *   timeout: '30s',
 * })
 * ```
 */
export function waitFor(
  condition: (context: Context) => boolean | Promise<boolean>,
  options: WaitForOptions = {},
): Promise<void> {
  try {
    if (typeof condition !== 'function') {
      throw new TypeError('waitFor(condition) expects a function')
    }
    const timeoutMs = toMs(options.timeout ?? '10s')
    const interval = options.interval ?? 100
    if (typeof interval !== 'function') toMs(interval)
    return poll(condition, interval, timeoutMs, options.clock ?? systemClock, options.signal)
  } catch (error) {
    return Promise.reject(error)
  }
}

function poll(
  condition: (context: Context) => boolean | Promise<boolean>,
  interval: Duration | ((attempt: number) => Duration),
  timeoutMs: number,
  clock: Clock,
  parent: AbortSignal | undefined,
): Promise<void> {
  if (parent?.aborted) return Promise.reject(parent.reason)

  return new Promise<void>((resolve, reject) => {
    const controller = new AbortController()
    const { signal } = controller
    let deadline: TimerHandle
    let cancelParent: (() => void) | undefined

    const end = (failure?: { readonly error: unknown }): void => {
      if (signal.aborted) return
      if (deadline !== undefined) clock.clearTimeout(deadline)
      cancelParent?.()
      if (failure) {
        controller.abort(failure.error)
        reject(failure.error)
      } else {
        controller.abort(new DOMException('The wait ended', 'AbortError'))
        resolve()
      }
    }

    if (timeoutMs !== Number.POSITIVE_INFINITY) {
      deadline = clock.setTimeout(() => end({ error: new TimeoutError(timeoutMs) }), timeoutMs)
    }
    // a clock may fire a timer of 0ms right away
    if (signal.aborted) return
    if (parent) cancelParent = onAbort(parent, () => end({ error: parent.reason }))

    const check = async (): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        const ready: unknown = await condition({ signal, attempt })
        if (signal.aborted) return
        if (typeof ready !== 'boolean') {
          throw new TypeError(`waitFor(condition) expects a boolean, got ${typeof ready}`)
        }
        if (ready) return end()

        const delay = toMs(typeof interval === 'function' ? interval(attempt) : interval)
        if (!(await sleep(clock, Math.max(delay, MIN_INTERVAL_MS), signal))) return
      }
    }

    check().catch((error: unknown) => end({ error }))
  })
}
