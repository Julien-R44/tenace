import { UnexpectedError } from '../errors.ts'
import { Result } from '../result/namespace.ts'

interface Waiters {
  readonly callbacks: Set<() => void>
  readonly listener: () => void
}

const waiting = new WeakMap<AbortSignal, Waiters>()

/**
 * Calls `callback` once when `signal` aborts. Returns a function cancelling it. However many
 * callbacks wait on a signal (a batch of executions), it holds one listener, removed as soon
 * as no callback is left.
 */
export function onAbort(signal: AbortSignal, callback: () => void): () => void {
  let waiters = waiting.get(signal)
  if (!waiters) {
    const callbacks = new Set<() => void>()
    const listener = (): void => {
      waiting.delete(signal)
      for (const waiter of callbacks) waiter()
    }
    waiters = { callbacks, listener }
    waiting.set(signal, waiters)
    signal.addEventListener('abort', listener, { once: true })
  }

  const entry = waiters
  entry.callbacks.add(callback)
  return () => {
    if (!entry.callbacks.delete(callback) || entry.callbacks.size > 0) return
    if (waiting.get(signal) !== entry) return
    waiting.delete(signal)
    signal.removeEventListener('abort', entry.listener)
  }
}

/**
 * Settles like `start()`, or rejects with `signal.reason` as soon as the signal aborts,
 * including while `start` runs synchronously. `start` is not called when already aborted.
 */
export function raceAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const cancel = onAbort(signal, () => reject(signal.reason))
    let promise: Promise<T>
    try {
      promise = start()
    } catch (error) {
      promise = Promise.reject(error)
    }
    promise.then(
      value => {
        cancel()
        resolve(value)
      },
      (error: unknown) => {
        cancel()
        reject(error)
      },
    )
  })
}

/**
 * Resolves like `promise`, or with an `UnexpectedError` wrapping the abort reason as soon as
 * the signal aborts. Never rejects if `promise` never rejects.
 */
export function raceSignal(promise: Promise<Result.Any>, signal: AbortSignal): Promise<Result.Any> {
  if (signal.aborted) return Promise.resolve(Result.err(new UnexpectedError(signal.reason)))
  return new Promise((resolve, reject) => {
    const cancel = onAbort(signal, () => resolve(Result.err(new UnexpectedError(signal.reason))))
    promise.then(
      result => {
        cancel()
        resolve(result)
      },
      (error: unknown) => {
        cancel()
        reject(error)
      },
    )
  })
}
