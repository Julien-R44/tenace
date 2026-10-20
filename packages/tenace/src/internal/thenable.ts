/**
 * Any thenable, not only native promises of this realm (`instanceof Promise`).
 */
export function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}
