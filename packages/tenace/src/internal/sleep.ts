import type { Clock } from '../clock.ts'

const { setImmediate } = globalThis as { setImmediate?: (callback: () => void) => unknown }

/**
 * Runs a callback in a task of its own, after the microtasks, I/O and timers due by then:
 * `setImmediate` where the runtime has it (Node, Bun, workerd with `nodejs_compat`), without
 * the 1ms or more of `setTimeout(0)`. A `MessageChannel` is no task in workerd: its
 * messages arrive between microtasks.
 */
export const macrotask: (callback: () => void) => void = setImmediate
  ? callback => setImmediate(callback)
  : callback => globalThis.setTimeout(callback, 0)

const yields = new Set<Promise<void>>()

/**
 * Yields of `yieldToEventLoop` that did not resolve yet, so a `TestClock` lets the code
 * that yielded go on before it decides which timer is next.
 */
export function pendingYields(): ReadonlySet<Promise<void>> {
  return yields
}

/**
 * Resolves after a task of its own, so a loop that never waits on a timer (retries without
 * delay of a function failing synchronously) lets the other timers and I/O run.
 */
export function yieldToEventLoop(): Promise<void> {
  const done: Promise<void> = new Promise(resolve =>
    macrotask(() => {
      yields.delete(done)
      resolve()
    }),
  )
  yields.add(done)
  return done
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
