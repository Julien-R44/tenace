import type { CircuitRejectionState } from './errors.ts'
import { reportError } from './internal/report_error.ts'
import type { AnyResult } from './result.ts'
import type { CircuitState } from './strategies/circuit_breaker/machine.ts'

export type Attributes = Readonly<Record<string, string | number | boolean>>

/**
 * Everything strategies report. `attempt` is 1-based.
 */
/**
 * What a retry event is about: the error of the attempt, or the value `retryIfValue`
 * rejected (`'value' in event`).
 */
export type RetryEventCause =
  | { readonly error: unknown }
  | { readonly value: unknown; readonly error?: undefined }

export type TenaceEvent =
  | ({
      readonly type: 'retry.scheduled'
      readonly attempt: number
      readonly delayMs: number
    } & RetryEventCause)
  | ({ readonly type: 'retry.exhausted'; readonly attempts: number } & RetryEventCause)
  | ({
      readonly type: 'retry.declined'
      readonly attempt: number
      readonly reason: 'budget' | 'idempotency' | 'delay'
    } & RetryEventCause)
  | { readonly type: 'timeout'; readonly attempt: number; readonly timeoutMs: number }
  | {
      readonly type: 'circuit.state_changed'
      readonly breaker: string
      readonly from: CircuitState
      readonly to: CircuitState
    }
  | {
      readonly type: 'circuit.rejected'
      readonly breaker: string
      readonly state: CircuitRejectionState
      readonly retryAfterMs: number | undefined
    }
  | {
      readonly type: 'bulkhead.rejected'
      readonly bulkhead: string
      readonly running: number
      readonly queued: number
    }
  | { readonly type: 'fallback.used'; readonly error: unknown }
  | { readonly type: 'fallback.stale'; readonly key: string; readonly ageMs: number }
  | {
      readonly type: 'rate_limit.rejected'
      readonly key: string
      readonly retryAfterMs: number | undefined
    }
  | { readonly type: 'lock.rejected'; readonly key: string }
  | { readonly type: 'dedupe.joined'; readonly key: string }
  | { readonly type: 'cache.hit'; readonly key: string }
  | { readonly type: 'cache.miss'; readonly key: string }
  | { readonly type: 'cache.stale'; readonly key: string; readonly error: unknown }
  | { readonly type: 'cache.failed'; readonly key: string; readonly error: unknown }
  | { readonly type: 'custom'; readonly name: string; readonly attributes?: Attributes }

export interface ExecutionInfo {
  /**
   * Operation name (low cardinality), from `execute(fn, { name })` or `Tenace.policy({ name })`.
   */
  readonly name: string
  /**
   * Strategy names, outermost first.
   */
  readonly strategies: readonly string[]
  readonly attributes: Attributes
}

export interface AttemptInfo {
  readonly attempt: number
}

/**
 * Per-execution hooks given to the strategies.
 */
export interface ExecutionScope {
  /**
   * Wraps each call of the user function. Run `run` inside your span context so the user's
   * own spans (HTTP, DB) get the attempt span as parent. Resolves to a Result, never rejects.
   */
  attempt(info: AttemptInfo, run: () => Promise<AnyResult>): Promise<AnyResult>
  event(event: TenaceEvent): void
}

/**
 * Around-advice observability contract. Implemented by `@julr/tenace-otel`, by `listener()`
 * and by the built-in diagnostics_channel publisher. `run` resolves to the final Result of
 * the execution (it rejects only on bugs or when the caller aborts).
 */
export interface Instrumentation {
  execution(
    info: ExecutionInfo,
    run: (scope: ExecutionScope) => Promise<AnyResult>,
  ): Promise<AnyResult>
}

export const noopScope: ExecutionScope = Object.freeze({
  attempt: (_info: AttemptInfo, run: () => Promise<AnyResult>): Promise<AnyResult> => run(),
  event: (): void => {},
})

export const noopInstrumentation: Instrumentation = Object.freeze({
  execution: (
    _info: ExecutionInfo,
    run: (scope: ExecutionScope) => Promise<AnyResult>,
  ): Promise<AnyResult> => run(noopScope),
})

/**
 * Runs an observer callback. Its error is reported without breaking the execution or the
 * other observers: with `globalThis.reportError` when available, as an uncaught error
 * otherwise.
 */
function safely(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    reportError(error)
  }
}

/**
 * Runs several instrumentations: the first one wraps the others. An event handler that
 * throws does not keep the event from the others, its error is reported (see `listener()`).
 */
export function combine(...items: readonly Instrumentation[]): Instrumentation {
  if (items.length === 0) return noopInstrumentation
  if (items.length === 1) return items[0]!
  return items.reduceRight((inner, outer) => ({
    execution: (info, run) =>
      outer.execution(info, outerScope =>
        inner.execution(info, innerScope =>
          run({
            attempt: (attempt, fn) =>
              outerScope.attempt(attempt, () => innerScope.attempt(attempt, fn)),
            event: event => {
              safely(() => outerScope.event(event))
              safely(() => innerScope.event(event))
            },
          }),
        ),
      ),
  }))
}

/**
 * Events only, for logs or custom metrics. Errors thrown by `onEvent` are reported with
 * `globalThis.reportError`, or as an uncaught error when the runtime has none.
 *
 * ```ts
 * Tenace.instrument(listener((event, info) => logger.info({ event, operation: info.name })))
 * ```
 */
export function listener(
  onEvent: (event: TenaceEvent, info: ExecutionInfo) => void,
): Instrumentation {
  return {
    execution: (info, run) =>
      run({
        attempt: (_attempt, fn) => fn(),
        event: event => safely(() => onEvent(event, info)),
      }),
  }
}
