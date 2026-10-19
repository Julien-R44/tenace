import type { ExecutionContext } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { BulkheadFullError, UnexpectedError } from '../errors.ts'
import { Scheduler } from '../internal/scheduler.ts'
import { type AnyResult, err } from '../result.ts'
import { type Next, Strategy } from '../strategy.ts'

export interface BulkheadOptions {
  /**
   * Calls running at the same time.
   */
  readonly concurrency: number
  /**
   * Name used in events and `describe()`. Defaults to `bulkhead`.
   */
  readonly name?: string
  /**
   * Calls waiting for a slot. Defaults to `0`: reject right away when every slot is busy.
   */
  readonly queue?: number
  /**
   * Longest time a call waits in the queue before being rejected. Defaults to no limit.
   */
  readonly maxWait?: Duration
}

function checkCount(name: string, value: number, min: number): number {
  if (!(value === Number.POSITIVE_INFINITY || (Number.isInteger(value) && value >= min))) {
    throw new RangeError(`Invalid ${name}: ${value}. Expected an integer >= ${min}`)
  }
  return value
}

/**
 * Limits concurrent calls to protect a dependency (and the caller's resources). Adds
 * `BulkheadFullError` to the error channel. Share the instance to share the limit.
 *
 * ```ts
 * const bulkhead = new Bulkhead({ concurrency: 10, queue: 100, maxWait: '2s' })
 * ```
 */
export class Bulkhead extends Strategy<BulkheadFullError> {
  readonly name: string
  readonly #scheduler: Scheduler
  readonly #maxWaitMs: number | undefined

  constructor(options: BulkheadOptions) {
    super()
    this.name = options.name ?? 'bulkhead'
    const concurrency = checkCount('concurrency', options.concurrency, 1)
    const queue = checkCount('queue', options.queue ?? 0, 0)
    this.#scheduler = new Scheduler(concurrency, queue)
    this.#maxWaitMs = options.maxWait === undefined ? undefined : toMs(options.maxWait)
  }

  get concurrency(): number {
    return this.#scheduler.concurrency
  }

  /**
   * Calls currently running.
   */
  get running(): number {
    return this.#scheduler.running
  }

  /**
   * Calls currently waiting for a slot.
   */
  get queued(): number {
    return this.#scheduler.queued
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    const release = await this.#scheduler.acquire({
      signal: context.signal,
      clock: context.clock,
      ...(this.#maxWaitMs !== undefined && { maxWaitMs: this.#maxWaitMs }),
    })
    if (!release) {
      if (context.signal.aborted) return err(new UnexpectedError(context.signal.reason))
      const { running, queued } = this.#scheduler
      context.emit({ type: 'bulkhead.rejected', bulkhead: this.name, running, queued })
      return err(new BulkheadFullError(running, queued))
    }

    try {
      if (context.signal.aborted) return err(new UnexpectedError(context.signal.reason))
      return await next(context)
    } finally {
      release()
    }
  }
}
