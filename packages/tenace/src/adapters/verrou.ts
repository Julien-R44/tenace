import { systemClock } from '../clock.ts'
import { type Duration, toMs } from '../duration.ts'
import { sleep } from '../internal/sleep.ts'
import type { LockAcquireOptions, LockLease, LockProvider } from '../strategies/lock.ts'

/**
 * The parts of a Verrou lock factory Tenace uses (no runtime import).
 */
export interface VerrouLike {
  createLock(
    name: string,
    ttl?: number | null,
  ): {
    acquireImmediately(): Promise<boolean>
    release(): Promise<void>
  }
}

export interface VerrouAdapterOptions {
  /**
   * Delay between two attempts while the lock is held elsewhere. Defaults to `250ms`, like
   * Verrou.
   */
  readonly retryDelay?: Duration
}

/**
 * Uses `@verrou/core` (Redis, database, DynamoDB... locks) as lock provider.
 *
 * ```ts
 * import { Verrou } from '@verrou/core'
 * import { verrou } from '@julr/tenace/adapters/verrou'
 *
 * const lock = new Lock({ provider: verrou(verrouInstance), key: 'reports', timeout: '5s' })
 * ```
 *
 * The adapter retries itself instead of using Verrou's retry options, so it stops waiting
 * as soon as the execution aborts and never waits past the lock `timeout` (`0` tries once).
 * Without a lock `ttl`, Verrou's default ttl applies (30s).
 */
export function verrou(factory: VerrouLike, options: VerrouAdapterOptions = {}): LockProvider {
  const retryDelayMs = toMs(options.retryDelay ?? 250)
  if (!(retryDelayMs > 0 && Number.isFinite(retryDelayMs)))
    throw new RangeError(`Invalid retryDelay: ${retryDelayMs}ms`)

  return {
    async acquire(key: string, options: LockAcquireOptions): Promise<LockLease | undefined> {
      const { signal, timeoutMs, clock = systemClock } = options
      const lock = factory.createLock(key, options.ttlMs)
      const deadline = clock.now() + (timeoutMs ?? Number.POSITIVE_INFINITY)

      while (!signal.aborted) {
        if (await lock.acquireImmediately()) return { release: () => lock.release() }
        const remainingMs = deadline - clock.now()
        if (remainingMs <= 0) return undefined
        await sleep(clock, Math.min(retryDelayMs, remainingMs), signal)
      }
      return undefined
    },
  }
}
