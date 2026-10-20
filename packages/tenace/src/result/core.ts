const RESULT_BRAND: unique symbol = Symbol.for('@julr/tenace/result') as never

/**
 * Successful outcome. Results are plain objects with a non-enumerable brand, so a user
 * payload that merely looks like a Result (`{ ok: false, error }`) is never mistaken for one.
 */
export interface Ok<out T> {
  readonly ok: true
  readonly value: T
  readonly [RESULT_BRAND]: true
}

/**
 * Failed outcome.
 */
export interface Err<out E> {
  readonly ok: false
  readonly error: E
  readonly [RESULT_BRAND]: true
}

export type Result<T, E> = Ok<T> | Err<E>
export type AnyResult = Ok<unknown> | Err<unknown>

/**
 * Value type of a Result (distributive).
 */
export type ValueOf<R> = R extends Ok<infer T> ? T : never

/**
 * Error type of a Result (distributive).
 */
export type ErrorOfResult<R> = R extends Err<infer E> ? E : never

export function ok(): Ok<void>
export function ok<T>(value: T): Ok<T>
export function ok(value?: unknown): Ok<unknown> {
  return Object.defineProperty({ ok: true, value }, RESULT_BRAND, { value: true }) as Ok<unknown>
}

export function err<const E>(error: E): Err<E> {
  return Object.defineProperty({ ok: false, error }, RESULT_BRAND, { value: true }) as Err<E>
}

/**
 * Whether the value is a Result created by any copy of Tenace.
 */
export function isResult(value: unknown): value is AnyResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[RESULT_BRAND] === true
  )
}
