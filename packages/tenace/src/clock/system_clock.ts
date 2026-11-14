import type { Temporal } from 'temporal-polyfill'

import { temporal } from './temporal.ts'
import type { Deadline, TimeSource, TimerOptions, WaitOptions } from './types.ts'

/**
 * Longest delay of the global timers: longer ones fire after ~1ms.
 */
const MAX_TIMER_MS = 2_147_483_647

/**
 * The time of the system: its clocks and the global timers. It is the
 * time source of a clock that is not faked.
 */
export class SystemClock implements TimeSource {
  now(): Temporal.Instant {
    return temporal.Now.instant()
  }

  monotonic(): number {
    return performance.now()
  }

  wait(milliseconds: number, options?: WaitOptions): Promise<void> {
    return delay(milliseconds, options?.signal, options?.ref ?? true)
  }

  timeout(milliseconds: number, options?: TimerOptions): Deadline {
    const controller = new AbortController()
    const cancel = schedule(
      milliseconds,
      () => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')),
      options?.ref ?? true,
    )

    return { signal: controller.signal, [Symbol.dispose]: cancel }
  }
}

/**
 * `setTimeout` of `node:timers/promises`, rewritten on the global timers:
 * only Node.js and Bun have `timers/promises` (workerd with
 * `nodejs_compat` only), and it does not handle delays beyond the
 * 2^31 - 1 ms of the global timers either, which it cuts to 1ms. Rejects
 * with the same `AbortError` when the signal aborts.
 */
function delay(milliseconds: number, signal: AbortSignal | undefined, ref: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))

    const abort = (): void => {
      cancel()
      reject(abortError(signal!))
    }
    const cancel = schedule(
      milliseconds,
      () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      },
      ref,
    )
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Calls `fire` once after `milliseconds`, chaining global timers for
 * delays beyond their limit, and returns the function that cancels it.
 * `Infinity` holds no timer. Without `ref`, each timer is unref'd where the
 * runtime's timers are objects with `unref()` (Node.js, Bun), and left as is
 * elsewhere.
 */
function schedule(milliseconds: number, fire: () => void, ref: boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const next = (remaining: number): void => {
    const chunk = Math.min(remaining, MAX_TIMER_MS)
    timer = setTimeout(() => (remaining > chunk ? next(remaining - chunk) : fire()), chunk)
    if (!ref) (timer as { unref?: () => unknown }).unref?.()
  }

  if (milliseconds !== Number.POSITIVE_INFINITY) next(milliseconds > 0 ? milliseconds : 0)
  return () => clearTimeout(timer)
}

/**
 * The error Node.js timers reject with when their signal aborts.
 */
export function abortError(signal: AbortSignal): Error {
  return Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  })
}
