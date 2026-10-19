import { type Clock, systemClock } from '../clock.ts'
import { type Duration, toMs } from '../duration.ts'

export interface RetryBudgetOptions {
  /**
   * Retries allowed per execution, on average over the window. Defaults to `0.2` (20%).
   */
  readonly ratio?: number
  /**
   * Retries always allowed per second, even with little traffic. Defaults to `10`.
   */
  readonly minPerSecond?: number
  /**
   * Window over which executions and retries are counted. Defaults to `10s`.
   */
  readonly window?: Duration
  /**
   * Defaults to the clock of each execution (`execute(fn, { clock })`, else the system clock).
   */
  readonly clock?: Clock
}

const BUCKETS = 10

/**
 * Caps the share of retries across every execution using it, so retries cannot amplify an
 * outage (a retry storm). Share one instance between the policies that call the same
 * dependency.
 *
 * ```ts
 * const budget = new RetryBudget({ ratio: 0.1 })
 * const policy = Tenace.policy().withRetry({ retries: 3, budget })
 * ```
 */
export class RetryBudget {
  readonly ratio: number
  readonly minPerSecond: number
  readonly windowMs: number
  readonly #clock: Clock | undefined
  readonly #bucketMs: number
  readonly #executions = Array.from({ length: BUCKETS }, () => 0)
  readonly #retries = Array.from({ length: BUCKETS }, () => 0)
  #bucketStart: number | undefined
  #bucketIndex = 0

  constructor(options: RetryBudgetOptions = {}) {
    this.ratio = options.ratio ?? 0.2
    this.minPerSecond = options.minPerSecond ?? 10
    this.windowMs = toMs(options.window ?? '10s')
    if (!(this.ratio >= 0)) throw new RangeError(`Invalid retry budget ratio: ${this.ratio}`)
    if (!(this.minPerSecond >= 0)) {
      throw new RangeError(`Invalid retry budget minPerSecond: ${this.minPerSecond}`)
    }
    if (!(this.windowMs > 0 && Number.isFinite(this.windowMs))) {
      throw new RangeError(`Invalid retry budget window: ${this.windowMs}ms`)
    }
    this.#clock = options.clock
    this.#bucketMs = this.windowMs / BUCKETS
  }

  /**
   * Records an execution (called once per execution by the retry strategy). `clock` is the
   * one of the execution, used when the budget has none.
   */
  recordExecution(clock?: Clock): void {
    this.#rotate(clock)
    this.#executions[this.#bucketIndex]!++
  }

  /**
   * Takes one retry from the budget. Returns `false` when the budget is exhausted.
   */
  tryAcquire(clock?: Clock): boolean {
    this.#rotate(clock)
    const executions = sum(this.#executions)
    const retries = sum(this.#retries)
    const allowed = this.minPerSecond * (this.windowMs / 1000) + this.ratio * executions
    if (retries + 1 > allowed) return false
    this.#retries[this.#bucketIndex]!++
    return true
  }

  #rotate(executionClock: Clock = systemClock): void {
    const now = (this.#clock ?? executionClock).now()
    this.#bucketStart ??= now
    const elapsed = now - this.#bucketStart
    if (elapsed < 0) {
      // another clock, behind the one that started the window: start a new window
      this.#executions.fill(0)
      this.#retries.fill(0)
      this.#bucketStart = now
      return
    }
    if (elapsed < this.#bucketMs) return
    const steps = Math.min(BUCKETS, Math.floor(elapsed / this.#bucketMs))
    for (let i = 0; i < steps; i++) {
      this.#bucketIndex = (this.#bucketIndex + 1) % BUCKETS
      this.#executions[this.#bucketIndex] = 0
      this.#retries[this.#bucketIndex] = 0
    }
    this.#bucketStart += Math.floor(elapsed / this.#bucketMs) * this.#bucketMs
  }
}

function sum(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total
}
