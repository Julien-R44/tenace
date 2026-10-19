import { type Clock, systemClock } from '../clock.ts'
import type { ExecutionContext } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { LockNotAcquiredError, UnexpectedError } from '../errors.ts'
import { Scheduler } from '../internal/scheduler.ts'
import { type AnyResult, err } from '../result.ts'
import { type Next, Strategy } from '../strategy.ts'

export interface LockLease {
  release(): Promise<void> | void
}

export interface LockAcquireOptions {
  /**
   * Signal of the execution. Stop waiting as soon as it aborts.
   */
  readonly signal: AbortSignal
  /**
   * Longest time to wait for the lock. `undefined` waits as long as the signal allows.
   */
  readonly timeoutMs: number | undefined
  /**
   * How long the lock is held at most (distributed locks), `undefined` for the provider
   * default.
   */
  readonly ttlMs: number | undefined
  /**
   * Clock of the execution, for providers that wait in process.
   */
  readonly clock?: Clock | undefined
}

/**
 * Something that hands out locks. Resolves `undefined` when the lock was not acquired in
 * time. Use the `verrou` adapter for distributed locks.
 */
export interface LockProvider {
  acquire(key: string, options: LockAcquireOptions): Promise<LockLease | undefined>
}

/**
 * In-process locks (one holder per key, FIFO). Releasing a lease twice releases once.
 */
export class MemoryLockProvider implements LockProvider {
  readonly #locks = new Map<string, Scheduler>()

  /**
   * Keys currently held or waited for.
   */
  get size(): number {
    return this.#locks.size
  }

  async acquire(key: string, options: LockAcquireOptions): Promise<LockLease | undefined> {
    const scheduler = this.#locks.get(key) ?? new Scheduler(1)
    this.#locks.set(key, scheduler)
    const release = await scheduler.acquire({
      signal: options.signal,
      ...(options.timeoutMs !== undefined && { maxWaitMs: options.timeoutMs }),
      clock: options.clock ?? systemClock,
    })
    if (!release) {
      this.#forgetIdle(key, scheduler)
      return undefined
    }
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        release()
        this.#forgetIdle(key, scheduler)
      },
    }
  }

  /**
   * Only forgets the key while it still maps to this scheduler: a late call (an aborted
   * waiter resuming) must not drop a newer scheduler that has a holder.
   */
  #forgetIdle(key: string, scheduler: Scheduler): void {
    if (this.#locks.get(key) !== scheduler) return
    if (scheduler.running === 0 && scheduler.queued === 0) this.#locks.delete(key)
  }
}

export interface LockOptions {
  /**
   * Defaults to an in-process provider shared by every lock without one.
   */
  readonly provider?: LockProvider | undefined
  /**
   * Lock key. Defaults to the execution key; one of them is required.
   */
  readonly key?: string | undefined
  /**
   * Longest time to wait for the lock. Defaults to waiting as long as the signal allows.
   */
  readonly timeout?: Duration | undefined
  /**
   * Expiration of the lock, for distributed providers.
   */
  readonly ttl?: Duration | undefined
}

/**
 * Shared by every `Lock` without a provider, so locks on the same key exclude each other
 * across policies.
 */
const defaultLockProvider = new MemoryLockProvider()

/**
 * Runs the inner steps while holding a lock. Adds `LockNotAcquiredError` to the error
 * channel. Locks are not reentrant: give nested locks distinct keys. A provider failure becomes an `UnexpectedError`.
 *
 * ```ts
 * const lock = new Lock({ provider: verrou(lockFactory), key: 'reports', timeout: '5s' })
 * ```
 */
export class Lock extends Strategy<LockNotAcquiredError> {
  readonly name = 'lock'
  readonly #provider: LockProvider
  readonly #key: string | undefined
  readonly #timeoutMs: number | undefined
  readonly #ttlMs: number | undefined

  constructor(options: LockOptions = {}) {
    super()
    this.#provider = options.provider ?? defaultLockProvider
    this.#key = options.key
    this.#timeoutMs = options.timeout === undefined ? undefined : toMs(options.timeout)
    this.#ttlMs = options.ttl === undefined ? undefined : toMs(options.ttl)
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    const key = this.#key ?? context.key
    if (key === undefined) {
      throw new TypeError('Lock needs a key: pass `key` to the lock or to execute(fn, { key })')
    }

    let lease: LockLease | undefined
    try {
      lease = await this.#provider.acquire(key, {
        signal: context.signal,
        timeoutMs: this.#timeoutMs,
        ttlMs: this.#ttlMs,
        clock: context.clock,
      })
    } catch (error) {
      return err(new UnexpectedError(error))
    }
    if (!lease) {
      if (context.signal.aborted) return err(new UnexpectedError(context.signal.reason))
      context.emit({ type: 'lock.rejected', key })
      return err(new LockNotAcquiredError(key))
    }

    try {
      if (context.signal.aborted) return err(new UnexpectedError(context.signal.reason))
      return await next(context)
    } finally {
      try {
        await lease.release()
      } catch {
        // the lock expires on its own; a failed release must not fail a finished call
      }
    }
  }
}
