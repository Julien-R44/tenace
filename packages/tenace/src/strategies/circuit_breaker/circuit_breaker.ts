import { type Clock, systemClock } from '../../clock.ts'
import type { ExecutionContext } from '../../context.ts'
import { type Duration, toMs } from '../../duration.ts'
import { CircuitOpenError } from '../../errors.ts'
import { type AnyResult, err } from '../../result.ts'
import { type Next, Strategy } from '../../strategy.ts'
import type { BreakerConfig, CallOutcome, CircuitState, TripConfig } from './machine.ts'
import { type CircuitBreakerStore, MemoryCircuitBreakerStore } from './store.ts'

/**
 * When the circuit opens:
 * - `{ consecutive: 5 }`: after 5 failures in a row.
 * - `{ rate: 0.5, calls: 20 }`: when at least 50% of the last 20 calls failed.
 * - `{ rate: 0.5, duration: '30s' }`: when at least 50% of the calls of the last 30s failed.
 *
 * Rate based trips wait for `minimumCalls` calls in the window (defaults: `calls` for a
 * count window, `10` for a time window). A time window is split in `buckets` (default 10).
 */
export type TripOptions =
  | { readonly consecutive: number }
  | { readonly rate: number; readonly calls: number; readonly minimumCalls?: number }
  | {
      readonly rate: number
      readonly duration: Duration
      readonly minimumCalls?: number
      readonly buckets?: number
    }

export interface CircuitBreakerOptions {
  /**
   * Name used in events and `describe()`. Defaults to `circuitBreaker`.
   */
  readonly name?: string
  /**
   * When to open. Defaults to `{ consecutive: 5 }` (5 failures in a row).
   */
  readonly trip?: TripOptions
  /**
   * How long the circuit stays open before admitting trial calls. A duration, or a
   * function of the number of consecutive openings (a backoff preset works). Must be
   * finite: use `isolate()` to keep a circuit open. Defaults to `30s`.
   */
  readonly openFor?: Duration | ((openCount: number) => Duration)
  readonly halfOpen?: {
    /**
     * Trial calls admitted at the same time while half-open. Others are rejected right
     * away. Defaults to `1`.
     */
    readonly permits?: number
    /**
     * Successful trial calls needed to close. Defaults to `permits`.
     */
    readonly successes?: number
    /**
     * A trial call still running after this long counts as a failure. Defaults to
     * `openFor` when it is a fixed duration other than 0, `30s` otherwise.
     */
    readonly maxWait?: Duration
  }
  /**
   * How a finished call counts. By default errors are failures, except rejections from
   * other policies (`CircuitOpenError`, `BulkheadFullError`, `RateLimitError`,
   * `LockNotAcquiredError`), which are
   * ignored. Calls whose signal was aborted are always ignored.
   */
  readonly classify?: (result: AnyResult) => CallOutcome
  /**
   * Called after each state change.
   */
  readonly onStateChange?: (event: {
    readonly from: CircuitState
    readonly to: CircuitState
  }) => void
  readonly store?: CircuitBreakerStore
  /**
   * Clock for open durations and windows. Defaults to the system clock, not the clock of
   * the execution: the circuit is shared by every execution using it.
   */
  readonly clock?: Clock
}

const REJECTION_TAGS: ReadonlySet<unknown> = new Set([
  'CircuitOpenError',
  'BulkheadFullError',
  'RateLimitError',
  'LockNotAcquiredError',
])

function defaultClassify(result: AnyResult): CallOutcome {
  if (result.ok) return 'success'
  return REJECTION_TAGS.has((result.error as { _tag?: unknown } | null)?._tag)
    ? 'ignored'
    : 'failure'
}

function toTripConfig(trip: TripOptions): TripConfig {
  if ('consecutive' in trip) {
    return { kind: 'consecutive', failures: positiveInteger('trip.consecutive', trip.consecutive) }
  }
  if (!(trip.rate > 0 && trip.rate <= 1)) {
    throw new RangeError(`Invalid trip.rate: ${trip.rate}. Expected a number in ]0, 1]`)
  }
  if ('calls' in trip) {
    const size = positiveInteger('trip.calls', trip.calls)
    const minimumCalls = positiveInteger('trip.minimumCalls', trip.minimumCalls ?? size)
    if (minimumCalls > size) {
      throw new RangeError(
        `Invalid trip.minimumCalls: ${minimumCalls}. Expected at most trip.calls (${size})`,
      )
    }
    return { kind: 'count', size, rate: trip.rate, minimumCalls }
  }
  const durationMs = toMs(trip.duration)
  if (!(durationMs > 0 && Number.isFinite(durationMs))) {
    throw new RangeError(`Invalid trip.duration: ${durationMs}ms`)
  }
  return {
    kind: 'time',
    durationMs,
    buckets: positiveInteger('trip.buckets', trip.buckets ?? 10),
    rate: trip.rate,
    minimumCalls: positiveInteger('trip.minimumCalls', trip.minimumCalls ?? 10),
  }
}

/**
 * A trial call may run as long as `openFor` by default, but a function (often jittered)
 * gives no stable value, and `0` would expire every trial call right away.
 */
function finiteOpenFor(ms: number): number {
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      `Invalid openFor: ${ms}. Expected a finite duration, use isolate() to keep a circuit open`,
    )
  }
  return ms
}

function defaultMaxWaitMs(openFor: Duration | ((openCount: number) => Duration)): number {
  if (typeof openFor === 'function') return 30_000
  const ms = toMs(openFor)
  return ms > 0 ? ms : 30_000
}

function positiveInteger(name: string, value: number): number {
  if (!(Number.isInteger(value) && value >= 1)) {
    throw new RangeError(`Invalid ${name}: ${value}. Expected an integer >= 1`)
  }
  return value
}

/**
 * Stops calling a failing dependency for a while, then lets trial calls through to check
 * whether it recovered. Adds `CircuitOpenError` to the error channel.
 *
 * Create one instance per dependency and share it: every policy it is added to shares
 * the same circuit.
 *
 * ```ts
 * const breaker = new CircuitBreaker({ trip: { consecutive: 5 }, openFor: '30s' })
 * const policy = Tenace.policy().withTimeout('1s').with(breaker)
 * ```
 */
export class CircuitBreaker extends Strategy<CircuitOpenError> {
  readonly name: string
  readonly config: BreakerConfig
  readonly #store: CircuitBreakerStore
  readonly #clock: Clock
  readonly #classify: (result: AnyResult) => CallOutcome
  readonly #onStateChange: CircuitBreakerOptions['onStateChange']
  /**
   * Last state reported, `undefined` once a call nobody observed may have changed it.
   */
  #lastState: CircuitState | undefined = 'closed'

  constructor(options: CircuitBreakerOptions = {}) {
    super()
    this.name = options.name ?? 'circuitBreaker'
    const { openFor = '30s' } = options
    // finite, so a store can keep the state as JSON; isolate() keeps a circuit open
    const openForMs =
      typeof openFor === 'function'
        ? (openCount: number) => finiteOpenFor(toMs(openFor(openCount)))
        : (
            (ms: number) => () =>
              ms
          )(finiteOpenFor(toMs(openFor)))
    const permits = positiveInteger('halfOpen.permits', options.halfOpen?.permits ?? 1)
    const maxWait = options.halfOpen?.maxWait
    const maxWaitMs = maxWait === undefined ? defaultMaxWaitMs(openFor) : toMs(maxWait)
    if (!(maxWaitMs > 0)) throw new RangeError(`Invalid halfOpen.maxWait: ${maxWaitMs}ms`)

    this.config = {
      trip: toTripConfig(options.trip ?? { consecutive: 5 }),
      openForMs,
      halfOpen: {
        permits,
        successes: positiveInteger('halfOpen.successes', options.halfOpen?.successes ?? permits),
        maxWaitMs,
      },
    }
    this.#store = options.store ?? new MemoryCircuitBreakerStore()
    this.#clock = options.clock ?? systemClock
    this.#classify = options.classify ?? defaultClassify
    this.#onStateChange = options.onStateChange
  }

  /**
   * Current state, as known by the store. Synchronous with the memory store.
   */
  get state(): CircuitState {
    const state = this.#store.state(this.#clock.now(), this.config)
    if (state instanceof Promise) {
      throw new TypeError('This store is asynchronous, use `await breaker.getState()`')
    }
    return state
  }

  async getState(): Promise<CircuitState> {
    return this.#store.state(this.#clock.now(), this.config)
  }

  /**
   * Forces the circuit open until the returned function is called. Isolations stack: the
   * circuit closes once every one of them is released.
   */
  async isolate(): Promise<() => Promise<void>> {
    await this.#store.isolate(this.config)
    await this.#notify()
    let released = false
    return async () => {
      if (released) return
      released = true
      await this.#store.release(this.config)
      await this.#notify()
    }
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    if (this.#lastState === undefined && this.#tracks(context)) {
      this.#lastState = await this.#store.state(this.#clock.now(), this.config)
    }
    const admitted = this.#store.admit(this.#clock.now(), this.config)
    // the memory store is synchronous: awaiting its values costs microtask hops on every call
    const admission = admitted instanceof Promise ? await admitted : admitted
    if (this.#tracks(context)) await this.#notify(context)
    if (!admission.admitted) {
      const { state, retryAfterMs } = admission
      context.emit({ type: 'circuit.rejected', breaker: this.name, state, retryAfterMs })
      return err(new CircuitOpenError(state, retryAfterMs))
    }

    let outcome: CallOutcome = 'ignored'
    try {
      const result = await next(context)
      if (!context.signal.aborted) outcome = this.#classify(result)
      return result
    } finally {
      const recorded = this.#store.record(admission.ticket, outcome, this.#clock.now(), this.config)
      if (recorded instanceof Promise) await recorded
      if (this.#tracks(context)) await this.#notify(context)
    }
  }

  #tracks(context?: ExecutionContext): boolean {
    return this.#onStateChange !== undefined || context?.observed === true
  }

  /**
   * Reports a change from the last state a tracked call saw. Untracked calls leave it as is,
   * so a change they caused is reported by the next tracked call, never lost.
   */
  async #notify(context?: ExecutionContext): Promise<void> {
    if (!this.#tracks(context)) return
    const state = await this.#store.state(this.#clock.now(), this.config)
    const from = this.#lastState
    this.#lastState = state
    if (from === undefined || from === state) return
    context?.emit({ type: 'circuit.state_changed', breaker: this.name, from, to: state })
    this.#onStateChange?.({ from, to: state })
  }
}
