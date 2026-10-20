import type { ExecutionContext } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { Result } from '../result/namespace.ts'
import { type Next, Strategy } from '../strategy.ts'

export interface StaleFallbackOptions {
  /**
   * Oldest value that may be served. Defaults to no limit.
   */
  readonly maxAge?: Duration | undefined
  /**
   * Keys remembered (least recently written are forgotten first). Defaults to `1000`.
   */
  readonly maxEntries?: number | undefined
  /**
   * Key the value is remembered under. Defaults to the execution key; one of them is
   * required, so a value is never served to another function.
   */
  readonly key?: string | undefined
}

/**
 * Remembers the last successful value per key and serves it when the inner steps fail
 * (stale-if-error). The error channel is unchanged: a failure with nothing remembered still
 * fails. Emits `fallback.stale`.
 */
export class StaleFallback extends Strategy {
  readonly name = 'staleFallback'
  readonly #values = new Map<string, { readonly value: unknown; readonly at: number }>()
  readonly #maxAgeMs: number
  readonly #maxEntries: number
  readonly #key: string | undefined

  constructor(options: StaleFallbackOptions = {}) {
    super()
    this.#maxAgeMs = toMs(options.maxAge ?? Number.POSITIVE_INFINITY)
    this.#maxEntries = options.maxEntries ?? 1000
    this.#key = options.key
    if (!(Number.isInteger(this.#maxEntries) && this.#maxEntries >= 1)) {
      throw new RangeError(`Invalid maxEntries: ${this.#maxEntries}. Expected an integer >= 1`)
    }
  }

  async execute(context: ExecutionContext, next: Next): Promise<Result.Any> {
    const key = this.#key ?? context.key
    if (key === undefined) {
      throw new TypeError(
        'StaleFallback needs a key: pass `key` to the stale fallback or to execute(fn, { key })',
      )
    }
    const result = await next(context)
    const now = context.clock.now()

    if (result.ok) {
      this.#values.delete(key)
      this.#values.set(key, { value: result.value, at: now })
      if (this.#values.size > this.#maxEntries)
        this.#values.delete(this.#values.keys().next().value!)
      return result
    }

    const stale = this.#values.get(key)
    if (!stale || context.signal.aborted || now - stale.at > this.#maxAgeMs) return result
    context.emit({ type: 'fallback.stale', key, ageMs: now - stale.at })
    return Result.ok(stale.value)
  }
}
