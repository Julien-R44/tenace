import type { ExecutionContext } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { TimeoutError } from '../errors.ts'
import { raceSignal } from '../internal/race_signal.ts'
import { reportError } from '../internal/report_error.ts'
import { linkSignal } from '../internal/signal.ts'
import { Result } from '../result/namespace.ts'
import { type Next, Strategy } from '../strategy.ts'

export interface TimeoutOptions {
  /**
   * - `aggressive` (default): returns `TimeoutError` at the deadline and aborts the signal,
   *   even if the function ignores it (its work keeps running in the background). Also stops
   *   waiting as soon as the caller aborts. A defect of that work (a throwing callback) is
   *   reported with `globalThis.reportError`, or as an uncaught error when the runtime has
   *   none.
   * - `cooperative`: aborts the signal at the deadline, then waits for the function to
   *   settle. A failure after the deadline becomes `TimeoutError`, a success is kept.
   *
   * Any other value throws a `RangeError` when the policy is built.
   */
  readonly mode?: 'aggressive' | 'cooperative' | undefined
}

/**
 * Bounds the time spent in the inner steps. The inner signal is aborted with the
 * `TimeoutError` as reason. Inside a retry it bounds each attempt, outside it bounds the total.
 */
export class Timeout extends Strategy<TimeoutError> {
  readonly name = 'timeout'
  readonly timeoutMs: number
  readonly mode: 'aggressive' | 'cooperative'

  constructor(duration: Duration, options: TimeoutOptions = {}) {
    super()
    this.timeoutMs = toMs(duration)
    const mode = options.mode ?? 'aggressive'
    if (mode !== 'aggressive' && mode !== 'cooperative') {
      throw new RangeError(
        `Invalid timeout mode: ${String(mode)}. Expected 'aggressive' or 'cooperative'`,
      )
    }
    this.mode = mode
  }

  async execute(context: ExecutionContext, next: Next): Promise<Result.Any> {
    if (this.timeoutMs === Number.POSITIVE_INFINITY) return next(context)

    const link = linkSignal(context.abortable ? context.signal : undefined)
    const error = new TimeoutError(this.timeoutMs)
    let timedOut = false
    let onDeadline: ((result: Result.Any) => void) | undefined
    const deadline = new Promise<Result.Any>(resolve => (onDeadline = resolve))

    const handle = context.clock.setTimeout(() => {
      timedOut = true
      link.abort(error)
      onDeadline!(Result.err(error))
    }, this.timeoutMs)

    try {
      const inner = next(context.with({ signal: link.signal }))
      let result: Result.Any
      if (this.mode === 'aggressive') {
        const raced = Promise.race([inner, deadline])
        result = await (context.abortable ? raceSignal(raced, context.signal) : raced)
        // a defect after the race was decided can no longer reject the execution
        void inner.catch(reportError)
      } else {
        result = await inner
      }
      if (!timedOut || result.ok) return result

      context.emit({ type: 'timeout', attempt: context.attempt, timeoutMs: this.timeoutMs })
      return Result.err(error)
    } finally {
      context.clock.clearTimeout(handle)
      link.dispose()
    }
  }
}
