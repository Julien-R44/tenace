const ERROR_BRAND: unique symbol = Symbol.for('@julr/tenace/error') as never

/**
 * Base class of every error produced by Tenace.
 *
 * - `_tag` is a literal discriminant used by the type-level error channel and `match()`.
 * - `code` is a stable `E_*` identifier for logs and serialization.
 * - `instanceof` keeps working across duplicated copies of the package (dual package,
 *   bundled + external, multiple versions) thanks to a global symbol brand.
 *
 * Subclasses must declare `_tag` and `code` as literal readonly fields. Declaring
 * `static readonly tag` with the same value as `_tag` makes `instanceof` work across
 * copies of the subclass too, otherwise the regular prototype check is used.
 */
export abstract class TenaceError extends Error {
  abstract readonly _tag: string
  abstract readonly code: string

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    Object.defineProperty(this, 'name', {
      value: new.target.name,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    Object.defineProperty(this, ERROR_BRAND, { value: true })
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (!isTenaceError(value)) return false
    if (this === TenaceError) return true
    if (Object.hasOwn(this, 'tag')) {
      return value._tag === (this as unknown as { tag: unknown }).tag
    }
    return Function.prototype[Symbol.hasInstance].call(this, value)
  }

  /**
   * JSON representation without the stack trace. Own enumerable fields of subclasses
   * (like `timeoutMs`) are included.
   */
  toJSON(): Record<string, unknown> {
    return {
      ...(this as object),
      _tag: this._tag,
      code: this.code,
      name: this.name,
      message: this.message,
      ...(this.cause !== undefined && { cause: serializeCause(this.cause) }),
    }
  }
}

function serializeCause(cause: unknown): unknown {
  if (!(cause instanceof Error) || 'toJSON' in cause) return cause
  return { name: cause.name, message: cause.message }
}

/**
 * Whether the value is an error produced by any copy of Tenace.
 */
export function isTenaceError(value: unknown): value is TenaceError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[ERROR_BRAND] === true
  )
}

/**
 * Wraps anything the user function threw. The raw thrown value is kept in `cause`.
 * `execute()` rethrows `cause` untouched, `settle()` returns this error.
 */
export class UnexpectedError extends TenaceError {
  static readonly tag = 'UnexpectedError'
  readonly _tag = 'UnexpectedError' as const
  readonly code = 'E_UNEXPECTED' as const
  declare readonly name: 'UnexpectedError'
  declare readonly cause: unknown

  constructor(cause: unknown) {
    super(describe(cause), { cause })
  }
}

/**
 * Message of a thrown value. Never throws, even for null-prototype objects or a throwing
 * `toString()`.
 */
function describe(value: unknown): string {
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

/**
 * A timeout strategy gave up waiting. In aggressive mode (default) it is returned at the
 * deadline even if the function ignores its signal.
 */
export class TimeoutError extends TenaceError {
  static readonly tag = 'TimeoutError'
  readonly _tag = 'TimeoutError' as const
  readonly code = 'E_TIMEOUT' as const
  declare readonly name: 'TimeoutError'
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`)
    this.timeoutMs = timeoutMs
  }
}

export type CircuitRejectionState = 'open' | 'half-open' | 'isolated'

/**
 * A circuit breaker rejected the call without running it.
 */
export class CircuitOpenError extends TenaceError {
  static readonly tag = 'CircuitOpenError'
  readonly _tag = 'CircuitOpenError' as const
  readonly code = 'E_CIRCUIT_OPEN' as const
  declare readonly name: 'CircuitOpenError'
  /**
   * State of the circuit when the call was rejected.
   */
  readonly state: CircuitRejectionState
  /**
   * When a new call may be admitted. `undefined` while the circuit is isolated.
   */
  readonly retryAfterMs: number | undefined

  constructor(state: CircuitRejectionState, retryAfterMs: number | undefined) {
    super(
      state === 'isolated'
        ? 'Circuit breaker is isolated'
        : `Circuit breaker is ${state}${retryAfterMs === undefined ? '' : `, retry after ${retryAfterMs}ms`}`,
    )
    this.state = state
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * A bulkhead rejected the call: every slot was busy and the queue was full, or the call
 * waited longer than `maxWait` in the queue.
 */
export class BulkheadFullError extends TenaceError {
  static readonly tag = 'BulkheadFullError'
  readonly _tag = 'BulkheadFullError' as const
  readonly code = 'E_BULKHEAD_FULL' as const
  declare readonly name: 'BulkheadFullError'
  /**
   * Calls running when this call was rejected.
   */
  readonly running: number
  /**
   * Calls waiting when this call was rejected.
   */
  readonly queued: number

  constructor(running: number, queued: number) {
    super(`Bulkhead is full (${running} running, ${queued} queued)`)
    this.running = running
    this.queued = queued
  }
}

/**
 * A rate limiter rejected the call.
 */
export class RateLimitError extends TenaceError {
  static readonly tag = 'RateLimitError'
  readonly _tag = 'RateLimitError' as const
  readonly code = 'E_RATE_LIMIT' as const
  declare readonly name: 'RateLimitError'
  readonly key: string
  /**
   * When a call may be admitted again. Retries wait at least this long.
   */
  readonly retryAfterMs: number

  constructor(key: string, retryAfterMs: number) {
    super(`Rate limit exceeded for "${key}", retry after ${retryAfterMs}ms`)
    this.key = key
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * A lock could not be acquired in time.
 */
export class LockNotAcquiredError extends TenaceError {
  static readonly tag = 'LockNotAcquiredError'
  readonly _tag = 'LockNotAcquiredError' as const
  readonly code = 'E_LOCK_NOT_ACQUIRED' as const
  declare readonly name: 'LockNotAcquiredError'
  readonly key: string

  constructor(key: string) {
    super(`Lock "${key}" could not be acquired`)
    this.key = key
  }
}

/**
 * Default fault injected by chaos testing.
 */
export class ChaosError extends TenaceError {
  static readonly tag = 'ChaosError'
  readonly _tag = 'ChaosError' as const
  readonly code = 'E_CHAOS' as const
  declare readonly name: 'ChaosError'

  constructor() {
    super('Fault injected by chaos testing')
  }
}
