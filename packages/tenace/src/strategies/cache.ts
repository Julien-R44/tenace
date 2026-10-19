import type { ExecutionContext } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { UnexpectedError } from '../errors.ts'
import { type AnyResult, err, ok } from '../result.ts'
import { type Next, Strategy } from '../strategy.ts'

/**
 * A cache with a get-or-set primitive. Tenace does not implement caching: plug a real cache
 * (the `bentocache` adapter, or a few lines around your own).
 */
export interface CacheProvider {
  getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    options: { readonly ttlMs: number | undefined },
  ): Promise<T>
}

export interface CacheOptions {
  readonly provider: CacheProvider
  /**
   * Cache key. Defaults to the execution key; one of them is required.
   */
  readonly key?: string
  readonly ttl?: Duration
}

/**
 * Thrown by the factory so the provider does not cache an `err` result. An `Error`, since
 * providers (bentocache) handle factory errors but not other thrown values.
 */
class SkipCache extends Error {
  constructor() {
    super('tenace: err results are not cached')
  }
}

/**
 * Serves the inner steps from a cache. Only successes are cached: when the inner steps
 * fail, their error is returned, unless the provider serves a stale value instead
 * (bentocache grace periods), which emits `cache.stale`. When the cache
 * itself fails, the inner steps run anyway (fail-open, at most once) and a `cache.failed`
 * event is emitted.
 *
 * ```ts
 * const users = Tenace.policy().withTimeout('1s').withCache({ provider: bentocache(bento), ttl: '1m' })
 * await users.execute(() => getUser(id), { key: `user:${id}` })
 * ```
 */
export class Cache extends Strategy {
  readonly name = 'cache'
  readonly #provider: CacheProvider
  readonly #key: string | undefined
  readonly #ttlMs: number | undefined

  constructor(options: CacheOptions) {
    super()
    this.#provider = options.provider
    this.#key = options.key
    this.#ttlMs = options.ttl === undefined ? undefined : toMs(options.ttl)
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    const key = this.#key ?? context.key
    if (key === undefined) {
      throw new TypeError('Cache needs a key: pass `key` to the cache or to execute(fn, { key })')
    }

    let running: Promise<AnyResult> | undefined
    let produced: AnyResult | undefined
    try {
      const value = await this.#provider.getOrSet(
        key,
        async () => {
          running ??= next(context)
          produced = await running
          if (!produced.ok) throw new SkipCache()
          return produced.value
        },
        { ttlMs: this.#ttlMs },
      )
      if (produced && !produced.ok) {
        // the provider served a stale value instead of the error (bentocache grace)
        context.emit({ type: 'cache.stale', key, error: produced.error })
      } else {
        context.emit({ type: produced ? 'cache.miss' : 'cache.hit', key })
      }
      return ok(value)
    } catch (error) {
      if (produced && !produced.ok) return produced
      context.emit({ type: 'cache.failed', key, error })
      if (running) return running
      return context.signal.aborted
        ? err(new UnexpectedError(context.signal.reason))
        : next(context)
    }
  }
}
