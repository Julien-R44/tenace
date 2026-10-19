/**
 * Pure circuit breaker state machine: `(state, input, now, config) => state'`.
 * No I/O and no clock, so the same logic can run in memory or in a distributed store.
 *
 * Store authoring: a `CircuitBreakerStore` keeps one `MachineState` (plain JSON data),
 * starts from `initialState(config)` and replaces it with the result of `admit`, `record`,
 * `isolate` and `release`, atomically (a transaction or a compare-and-set in a
 * distributed store). `currentState` answers `state()`.
 */

export type CircuitState = 'closed' | 'open' | 'half-open' | 'isolated'

/**
 * How a finished call counts: `ignored` calls do not move the circuit (for example the
 * caller aborted, or another policy rejected the call).
 */
export type CallOutcome = 'success' | 'failure' | 'ignored'

export type TripConfig =
  | { readonly kind: 'consecutive'; readonly failures: number }
  | {
      readonly kind: 'count'
      readonly size: number
      readonly rate: number
      readonly minimumCalls: number
    }
  | {
      readonly kind: 'time'
      readonly durationMs: number
      readonly buckets: number
      readonly rate: number
      readonly minimumCalls: number
    }

export interface BreakerConfig {
  readonly trip: TripConfig
  /**
   * Open duration for the n-th consecutive opening (1-based).
   */
  readonly openForMs: (openCount: number) => number
  readonly halfOpen: {
    /**
     * Trial calls admitted at the same time while half-open.
     */
    readonly permits: number
    /**
     * Successful trial calls needed to close.
     */
    readonly successes: number
    /**
     * A trial call still running after this long counts as a failure.
     */
    readonly maxWaitMs: number
  }
}

export interface TimeBucket {
  readonly index: number
  readonly calls: number
  readonly failures: number
}

export type WindowState =
  | { readonly kind: 'consecutive'; readonly failures: number }
  /**
   * Last outcomes, oldest first (`true` = failure).
   */
  | { readonly kind: 'count'; readonly outcomes: readonly boolean[] }
  | { readonly kind: 'time'; readonly buckets: readonly TimeBucket[] }

/**
 * Everything a store persists. Plain data, safe to serialize as JSON.
 */
export interface MachineState {
  readonly status: 'closed' | 'open' | 'half-open'
  /**
   * Incremented at each transition. Tickets from an older generation are ignored.
   */
  readonly generation: number
  readonly openUntil: number
  /**
   * Openings since the circuit was last closed by successful trial calls.
   */
  readonly openCount: number
  readonly window: WindowState
  /**
   * Start times of the trial calls in flight (half-open only).
   */
  readonly probes: readonly number[]
  readonly probeSuccesses: number
  /**
   * Active `isolate()` calls. The circuit rejects everything while > 0.
   */
  readonly isolations: number
}

export interface Ticket {
  readonly generation: number
  readonly startedAt: number
}

export type Admission =
  | { readonly admitted: true; readonly ticket: Ticket }
  | {
      readonly admitted: false
      readonly state: 'open' | 'half-open' | 'isolated'
      readonly retryAfterMs: number | undefined
    }

/**
 * State of a circuit that never ran: closed, empty window.
 */
export function initialState(config: BreakerConfig): MachineState {
  return {
    status: 'closed',
    generation: 0,
    openUntil: 0,
    openCount: 0,
    window: initialWindow(config.trip),
    probes: [],
    probeSuccesses: 0,
    isolations: 0,
  }
}

/**
 * Public state at `now`: an open circuit whose open duration elapsed reads `half-open`.
 */
export function currentState(state: MachineState, now: number): CircuitState {
  if (state.isolations > 0) return 'isolated'
  if (state.status === 'open' && now >= state.openUntil) return 'half-open'
  return state.status
}

/**
 * Asks to run a call. Returns the next state and, when admitted, the ticket to pass to
 * `record()` once the call finished.
 */
export function admit(
  state: MachineState,
  now: number,
  config: BreakerConfig,
): [MachineState, Admission] {
  if (state.isolations > 0) {
    return [state, { admitted: false, state: 'isolated', retryAfterMs: undefined }]
  }

  let next = state
  if (next.status === 'open') {
    if (now < next.openUntil) {
      return [next, { admitted: false, state: 'open', retryAfterMs: next.openUntil - now }]
    }
    next = {
      ...next,
      status: 'half-open',
      generation: next.generation + 1,
      probes: [],
      probeSuccesses: 0,
    }
  }

  if (next.status === 'half-open') {
    const { permits, maxWaitMs } = config.halfOpen
    if (next.probes.some(startedAt => now - startedAt >= maxWaitMs)) {
      next = open(next, now, config)
      return [next, { admitted: false, state: 'open', retryAfterMs: next.openUntil - now }]
    }
    if (next.probes.length >= permits) {
      const oldest = Math.min(...next.probes)
      return [next, { admitted: false, state: 'half-open', retryAfterMs: oldest + maxWaitMs - now }]
    }
    next = { ...next, probes: [...next.probes, now] }
  }

  return [next, { admitted: true, ticket: { generation: next.generation, startedAt: now } }]
}

/**
 * Records how an admitted call finished. A trial call finishing successfully after
 * `maxWaitMs` counts as a failure.
 */
export function record(
  state: MachineState,
  ticket: Ticket,
  outcome: CallOutcome,
  now: number,
  config: BreakerConfig,
): MachineState {
  if (ticket.generation !== state.generation) return state

  if (state.status === 'half-open') {
    const index = state.probes.indexOf(ticket.startedAt)
    if (index === -1) return state
    const probes = state.probes.toSpliced(index, 1)

    const late = now - ticket.startedAt >= config.halfOpen.maxWaitMs
    if (outcome === 'failure' || (outcome === 'success' && late)) return open(state, now, config)
    if (outcome === 'ignored') return { ...state, probes }

    const probeSuccesses = state.probeSuccesses + 1
    if (probeSuccesses >= config.halfOpen.successes) return close(state, config)
    return { ...state, probes, probeSuccesses }
  }

  if (state.status !== 'closed' || outcome === 'ignored') return state

  const window = recordWindow(state.window, config.trip, outcome === 'failure', now)
  if (outcome === 'failure' && shouldTrip(window, config.trip, now)) return open(state, now, config)
  return { ...state, window }
}

/**
 * Starts one isolation: the circuit rejects every call until it is released.
 */
export function isolate(state: MachineState): MachineState {
  return { ...state, isolations: state.isolations + 1 }
}

/**
 * Ends one isolation. When the last one ends the circuit starts closed again.
 */
export function release(state: MachineState, config: BreakerConfig): MachineState {
  if (state.isolations === 0) return state
  if (state.isolations > 1) return { ...state, isolations: state.isolations - 1 }
  return { ...close(state, config), isolations: 0 }
}

function open(state: MachineState, now: number, config: BreakerConfig): MachineState {
  const openCount = state.openCount + 1
  return {
    ...state,
    status: 'open',
    generation: state.generation + 1,
    openUntil: now + config.openForMs(openCount),
    openCount,
    window: initialWindow(config.trip),
    probes: [],
    probeSuccesses: 0,
  }
}

function close(state: MachineState, config: BreakerConfig): MachineState {
  return {
    ...state,
    status: 'closed',
    generation: state.generation + 1,
    openUntil: 0,
    openCount: 0,
    window: initialWindow(config.trip),
    probes: [],
    probeSuccesses: 0,
  }
}

function initialWindow(trip: TripConfig): WindowState {
  if (trip.kind === 'consecutive') return { kind: 'consecutive', failures: 0 }
  if (trip.kind === 'count') return { kind: 'count', outcomes: [] }
  return { kind: 'time', buckets: [] }
}

function bucketIndex(trip: TripConfig & { kind: 'time' }, now: number): number {
  return Math.floor(now / (trip.durationMs / trip.buckets))
}

function liveBuckets(
  buckets: readonly TimeBucket[],
  trip: TripConfig & { kind: 'time' },
  now: number,
): TimeBucket[] {
  const oldest = bucketIndex(trip, now) - trip.buckets + 1
  return buckets.filter(bucket => bucket.index >= oldest)
}

function recordWindow(
  window: WindowState,
  trip: TripConfig,
  failure: boolean,
  now: number,
): WindowState {
  if (window.kind === 'consecutive')
    return { kind: 'consecutive', failures: failure ? window.failures + 1 : 0 }
  if (window.kind === 'count' && trip.kind === 'count') {
    return { kind: 'count', outcomes: [...window.outcomes, failure].slice(-trip.size) }
  }
  if (window.kind !== 'time' || trip.kind !== 'time') return window

  const index = bucketIndex(trip, now)
  const buckets = liveBuckets(window.buckets, trip, now)
  const last = buckets.at(-1)
  if (last?.index === index) {
    buckets[buckets.length - 1] = {
      index,
      calls: last.calls + 1,
      failures: last.failures + (failure ? 1 : 0),
    }
  } else {
    buckets.push({ index, calls: 1, failures: failure ? 1 : 0 })
  }
  return { kind: 'time', buckets }
}

function shouldTrip(window: WindowState, trip: TripConfig, now: number): boolean {
  if (window.kind === 'consecutive' && trip.kind === 'consecutive')
    return window.failures >= trip.failures

  let calls = 0
  let failures = 0
  if (window.kind === 'count') {
    calls = window.outcomes.length
    failures = window.outcomes.filter(Boolean).length
  } else if (window.kind === 'time' && trip.kind === 'time') {
    for (const bucket of liveBuckets(window.buckets, trip, now)) {
      calls += bucket.calls
      failures += bucket.failures
    }
  }
  if (trip.kind === 'consecutive' || calls < trip.minimumCalls) return false
  return failures / calls >= trip.rate
}
