import type { ExecutionContext } from '../context.ts'
import { raceSignal } from '../internal/race_signal.ts'
import type { AnyResult } from '../result.ts'
import { type Next, Strategy } from '../strategy.ts'

interface InFlight {
  readonly promise: Promise<AnyResult>
  readonly controller: AbortController
  waiters: number
}

export interface DedupeOptions {
  /**
   * Key identifying identical calls. Defaults to the execution key; one of them is
   * required, so calls of different functions are never merged.
   */
  readonly key?: string
}

/**
 * Concurrent executions with the same key share one run of the inner steps
 * (single-flight). The shared run is aborted only when every caller aborted.
 *
 * ```ts
 * const users = Tenace.policy().withDedupe()
 * await Promise.all([users.execute(load, { key: 'user:1' }), users.execute(load, { key: 'user:1' })]) // one call
 * ```
 */
export class Dedupe extends Strategy {
  readonly name = 'dedupe'
  readonly #key: string | undefined
  readonly #inFlight = new Map<string, InFlight>()

  constructor(options: DedupeOptions = {}) {
    super()
    this.#key = options.key
  }

  /**
   * Keys currently running.
   */
  get pending(): number {
    return this.#inFlight.size
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    const key = this.#key ?? context.key
    if (key === undefined) {
      throw new TypeError('Dedupe needs a key: pass `key` to the dedupe or to execute(fn, { key })')
    }
    let entry = this.#inFlight.get(key)
    if (entry) {
      context.emit({ type: 'dedupe.joined', key })
    } else {
      const controller = new AbortController()
      const created: InFlight = {
        controller,
        waiters: 0,
        promise: next(context.with({ signal: controller.signal })).finally(() => {
          if (this.#inFlight.get(key) === created) this.#inFlight.delete(key)
        }),
      }
      entry = created
      this.#inFlight.set(key, entry)
    }

    const shared = entry
    shared.waiters++
    let left = false
    const leave = (): void => {
      if (left) return
      left = true
      if (--shared.waiters === 0 && context.signal.aborted) {
        if (this.#inFlight.get(key) === shared) this.#inFlight.delete(key)
        shared.controller.abort(context.signal.reason)
      }
    }
    if (!context.abortable) {
      try {
        return await shared.promise
      } finally {
        leave()
      }
    }
    context.signal.addEventListener('abort', leave, { once: true })
    try {
      return await raceSignal(shared.promise, context.signal)
    } finally {
      context.signal.removeEventListener('abort', leave)
      leave()
    }
  }
}
