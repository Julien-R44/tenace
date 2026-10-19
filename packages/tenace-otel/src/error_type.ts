import { isTenaceError, UnexpectedError } from '@julr/tenace'

/**
 * Low cardinality `error.type`, the type of the error (thrown values are unwrapped from
 * `UnexpectedError`):
 * - the `_tag` of Tenace errors and of any object with a string `_tag`,
 * - for an `Error`, its `name`, or its class name when `name` is the default `'Error'`
 *   (`class PaymentDeclined extends Error {}` gives `PaymentDeclined`),
 * - `_OTHER` otherwise.
 *
 * Never throws.
 */
export function errorType(error: unknown): string {
  try {
    if (error instanceof UnexpectedError) return errorType(error.cause)
    if (isTenaceError(error)) return error._tag
    if (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { _tag?: unknown })._tag === 'string'
    ) {
      return (error as { _tag: string })._tag
    }
    if (error instanceof Error) {
      if (typeof error.name === 'string' && error.name && error.name !== 'Error') {
        return error.name
      }
      const className: unknown = error.constructor?.name
      return typeof className === 'string' && className ? className : 'Error'
    }
  } catch {}
  return '_OTHER'
}

/**
 * Message of a thrown value. Never throws, even for null-prototype objects or a throwing
 * `toString()` (same logic as the message of `UnexpectedError`).
 */
export function describe(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === 'string') return value.message
    return String(value)
  } catch {
    try {
      return Object.prototype.toString.call(value)
    } catch {
      return 'Unknown error'
    }
  }
}
