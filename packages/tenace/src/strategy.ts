import type { ExecutionContext } from './context.ts'
import type { Result } from './result/namespace.ts'

const STRATEGY_BRAND: unique symbol = Symbol.for('@julr/tenace/strategy') as never

/**
 * Calls the next (inner) step of the policy. Always resolves to a Result.
 */
export type Next = (context: ExecutionContext) => Promise<Result.Any>

/**
 * Type-level description of what a strategy does to the error channel:
 * `E' = Exclude<E, Removes> | Adds`. `Removes` is contravariant: removing more errors
 * produces fewer, so an op removing everything is assignable to one removing nothing.
 */
export interface Op<out Adds, in Removes> {
  readonly adds?: Adds
  readonly removes?: (error: Removes) => void
}

/**
 * Any op: it may add any error and remove none.
 */
export type AnyOp = Op<unknown, never>

/**
 * A step of a policy (timeout, retry, circuit breaker...). Extend it to write your own.
 *
 * - `Adds`: errors this strategy can produce.
 * - `Removes`: errors this strategy handles (they no longer reach the caller).
 * - `Value`: values this strategy can produce instead of the function's value (fallbacks).
 *
 * `execute()` receives the context and the next step, and must resolve to a Result.
 * It must not throw: a thrown error is treated as a bug and rejects the whole execution.
 *
 * ```ts
 * class Audit extends Strategy<AuditError> {
 *   readonly name = 'audit'
 *   async execute(context: ExecutionContext, next: Next) {
 *     const result = await next(context)
 *     return result.ok ? result : Result.err(new AuditError(result.error))
 *   }
 * }
 * ```
 *
 * Strategy instances are shared by identity: a stateful strategy (circuit breaker,
 * bulkhead) added to several policies shares its state between them.
 */
export abstract class Strategy<out Adds = never, in Removes = never, out Value = never> {
  /**
   * Phantom type carrier. Never set at runtime.
   */
  declare readonly __types?: { readonly op: Op<Adds, Removes>; readonly value: Value }

  /**
   * Name used by `policy.describe()` and observability.
   */
  abstract readonly 'name': string

  abstract execute(context: ExecutionContext, next: Next): Promise<Result.Any>

  static {
    Object.defineProperty(this.prototype, STRATEGY_BRAND, { value: true })
  }
}

export type AnyStrategy = Strategy<unknown, never, unknown>

/**
 * Whether the value extends `Strategy` of any copy of Tenace (`instanceof` fails across
 * duplicated copies of the package).
 */
export function isStrategy(value: unknown): value is AnyStrategy {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[STRATEGY_BRAND] === true
  )
}
