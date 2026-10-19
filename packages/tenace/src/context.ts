import { type Clock, systemClock } from './clock.ts'
import { type ExecutionScope, noopScope, type TenaceEvent } from './instrumentation.ts'

/**
 * What the user function receives.
 */
export interface Context {
  /**
   * Aborted when the caller aborts, a timeout fires, or a sibling fails in a batch.
   * Pass it to `fetch` and friends so they stop working.
   */
  readonly signal: AbortSignal
  /**
   * 1-based attempt number. Incremented by retries.
   */
  readonly attempt: number
}

export interface ExecutionContextInit {
  readonly signal: AbortSignal
  readonly attempt?: number
  readonly clock?: Clock
  readonly scope?: ExecutionScope
  readonly key?: string | undefined
  readonly idempotent?: boolean
  readonly abortable?: boolean
}

/**
 * Immutable context flowing through the strategies of a policy. Strategies derive a new
 * context with `with()` (for example a child signal for a timeout, or the next attempt
 * for a retry) instead of mutating it.
 */
export class ExecutionContext implements Context {
  readonly signal: AbortSignal
  readonly attempt: number
  readonly clock: Clock
  /**
   * Instrumentation hooks of the current execution.
   */
  readonly scope: ExecutionScope
  /**
   * Key of the execution (`execute(fn, { key })`), used by dedupe, cache, locks and rate
   * limits that do not set their own.
   */
  readonly key: string | undefined
  /**
   * `false` when the function must not run twice (`execute(fn, { idempotent: false })`).
   */
  readonly idempotent: boolean
  /**
   * `false` when nothing can abort `signal` (no caller signal, no timeout or batch around),
   * so strategies can skip listening to it. Defaults to `true`.
   */
  readonly abortable: boolean

  constructor(init: ExecutionContextInit) {
    this.signal = init.signal
    this.attempt = init.attempt ?? 1
    this.clock = init.clock ?? systemClock
    this.scope = init.scope ?? noopScope
    this.key = init.key
    this.idempotent = init.idempotent ?? true
    this.abortable = init.abortable ?? true
    Object.freeze(this)
  }

  /**
   * Whether an instrumentation observes this execution.
   */
  get observed(): boolean {
    return this.scope !== noopScope
  }

  /**
   * Reports an event to the instrumentation of the current execution.
   */
  emit(event: TenaceEvent): void {
    this.scope.event(event)
  }

  with(patch: Partial<ExecutionContextInit>): ExecutionContext {
    return new ExecutionContext({
      signal: patch.signal ?? this.signal,
      attempt: patch.attempt ?? this.attempt,
      clock: patch.clock ?? this.clock,
      scope: patch.scope ?? this.scope,
      key: 'key' in patch ? patch.key : this.key,
      idempotent: patch.idempotent ?? this.idempotent,
      // a new signal comes from something that can abort it (a timeout, a batch)
      abortable: patch.abortable ?? (patch.signal ? true : this.abortable),
    })
  }
}
