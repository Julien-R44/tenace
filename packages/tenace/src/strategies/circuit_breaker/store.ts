import {
  admit,
  type Admission,
  type BreakerConfig,
  type CallOutcome,
  currentState,
  type CircuitState,
  initialState,
  isolate,
  type MachineState,
  record,
  release,
  type Ticket,
} from './machine.ts'

type MaybePromise<T> = T | Promise<T>

/**
 * Where a circuit breaker keeps its state. The memory store is the default; a distributed
 * store (Redis...) shares one circuit between processes. Every operation receives the
 * current time and the config, so stores stay stateless about them.
 *
 * Tickets are fenced: a result recorded with a ticket from an older generation (the
 * circuit transitioned since the call was admitted) is ignored.
 */
export interface CircuitBreakerStore {
  admit(now: number, config: BreakerConfig): MaybePromise<Admission>
  record(
    ticket: Ticket,
    outcome: CallOutcome,
    now: number,
    config: BreakerConfig,
  ): MaybePromise<void>
  isolate(config: BreakerConfig): MaybePromise<void>
  release(config: BreakerConfig): MaybePromise<void>
  state(now: number, config: BreakerConfig): MaybePromise<CircuitState>
}

/**
 * In-process store, synchronous.
 */
export class MemoryCircuitBreakerStore implements CircuitBreakerStore {
  #state: MachineState | undefined

  admit(now: number, config: BreakerConfig): Admission {
    const [next, admission] = admit(this.#current(config), now, config)
    this.#state = next
    return admission
  }

  record(ticket: Ticket, outcome: CallOutcome, now: number, config: BreakerConfig): void {
    this.#state = record(this.#current(config), ticket, outcome, now, config)
  }

  isolate(config: BreakerConfig): void {
    this.#state = isolate(this.#current(config))
  }

  release(config: BreakerConfig): void {
    this.#state = release(this.#current(config), config)
  }

  state(now: number, config: BreakerConfig): CircuitState {
    return currentState(this.#current(config), now)
  }

  #current(config: BreakerConfig): MachineState {
    return (this.#state ??= initialState(config))
  }
}
