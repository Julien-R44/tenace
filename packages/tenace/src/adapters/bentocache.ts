import type { CacheProvider } from '../strategies/cache.ts'

/**
 * The part of a BentoCache instance Tenace uses (no runtime import).
 */
export interface BentoCacheLike {
  getOrSet<T>(options: { key: string; factory: () => Promise<T>; ttl?: number }): Promise<T>
}

/**
 * Uses BentoCache (multi-tier cache, grace periods, stampede protection) as cache provider.
 *
 * ```ts
 * import { bentocache } from '@julr/tenace/adapters/bentocache'
 *
 * const users = Tenace.policy().withCache({ provider: bentocache(bento.namespace('users')), ttl: '1m' })
 * ```
 */
export function bentocache(cache: BentoCacheLike): CacheProvider {
  return {
    getOrSet: (key, factory, options) =>
      cache.getOrSet({ key, factory, ...(options.ttlMs !== undefined && { ttl: options.ttlMs }) }),
  }
}
