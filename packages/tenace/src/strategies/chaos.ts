import type { ExecutionContext } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { ChaosError, UnexpectedError } from '../errors.ts'
import { sleep } from '../internal/sleep.ts'
import { type AnyResult, err, ok } from '../result/core.ts'
import { type Next, Strategy } from '../strategy.ts'

export interface ChaosOptions<E = never, V = never> {
  /**
   * Share of calls affected, in `[0, 1]`. Defaults to `1`.
   */
  readonly rate?: number | undefined
  /**
   * Delay added before the call.
   */
  readonly latency?: Duration | (() => Duration) | undefined
  /**
   * Simulates a throw of the function (becomes an `UnexpectedError`), whether it returns or
   * throws the value. Defaults to a `ChaosError` when neither `error` nor `value` is set and
   * no latency is configured.
   */
  readonly throws?: (() => unknown) | undefined
  /**
   * Returns this error instead of calling the function (added to the error channel).
   */
  readonly error?: (() => E) | undefined
  /**
   * Returns this value instead of calling the function.
   */
  readonly value?: (() => V) | undefined
  /**
   * Turns the chaos on and off without rebuilding the policy. Defaults to `true`.
   */
  readonly enabled?: boolean | (() => boolean) | undefined
  /**
   * Source of randomness in `[0, 1)`, for tests. Defaults to `Math.random`.
   */
  readonly random?: (() => number) | undefined
}

/**
 * Injects faults (latency, throws, errors, values) to test how the rest of the policy and
 * the application behave. Not meant for production traffic unless gated with `enabled`.
 * A throwing `error`, `value` or `throws` factory simulates a throw of the function.
 *
 * ```ts
 * Tenace.policy().withChaos({ rate: 0.2, latency: '2s' }).withTimeout('1s')
 * ```
 */
export class Chaos<E = never, V = never> extends Strategy<E, never, V> {
  readonly name = 'chaos'
  readonly #options: ChaosOptions<E, V>
  readonly #rate: number

  constructor(options: ChaosOptions<E, V> = {}) {
    super()
    this.#rate = options.rate ?? 1
    if (!(this.#rate >= 0 && this.#rate <= 1)) {
      throw new RangeError(`Invalid chaos rate: ${this.#rate}. Expected a number in [0, 1]`)
    }
    this.#options = options
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    const { enabled = true, random = Math.random, latency, throws, error, value } = this.#options
    const active = typeof enabled === 'function' ? enabled() : enabled
    if (!active || this.#rate === 0 || random() >= this.#rate) return next(context)

    if (latency !== undefined) {
      const ms = toMs(typeof latency === 'function' ? latency() : latency)
      if (!(await sleep(context.clock, ms, context.signal))) {
        return err(new UnexpectedError(context.signal.reason))
      }
    }
    try {
      if (error) return err(error())
      if (value) return ok(value())
      if (throws) return err(new UnexpectedError(throws()))
    } catch (thrown) {
      return err(new UnexpectedError(thrown))
    }
    if (latency === undefined) return err(new UnexpectedError(new ChaosError()))
    return next(context)
  }
}
