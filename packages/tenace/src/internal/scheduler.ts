import type { Clock } from '../clock.ts'

export type Release = () => void

interface Waiter {
  grant(release: Release): void
  prev: Waiter | undefined
  next: Waiter | undefined
  queued: boolean
}

/**
 * FIFO concurrency limiter shared by the bulkhead and the lock. Never rejects: `acquire()`
 * resolves `undefined` when the slot cannot be obtained (queue full, wait too long, or
 * signal aborted). Waiters form a linked list, so leaving the queue is O(1).
 */
export class Scheduler {
  readonly concurrency: number
  readonly maxQueue: number
  #running = 0
  #queued = 0
  #head: Waiter | undefined
  #tail: Waiter | undefined

  constructor(concurrency: number, maxQueue: number = Number.POSITIVE_INFINITY) {
    this.concurrency = concurrency
    this.maxQueue = maxQueue
  }

  get running(): number {
    return this.#running
  }

  get queued(): number {
    return this.#queued
  }

  /**
   * Takes a slot right away, or returns `undefined`.
   */
  tryAcquire(): Release | undefined {
    if (this.#running >= this.concurrency) return undefined
    this.#running++
    return this.#releaser()
  }

  /**
   * Takes a slot, waiting in line when every slot is busy.
   */
  acquire(
    options: { signal?: AbortSignal; maxWaitMs?: number; clock?: Clock } = {},
  ): Promise<Release | undefined> {
    const { signal, maxWaitMs, clock } = options
    if (signal?.aborted) return Promise.resolve(undefined)

    const immediate = this.tryAcquire()
    if (immediate) return Promise.resolve(immediate)
    if (this.#queued >= this.maxQueue || maxWaitMs === 0) return Promise.resolve(undefined)

    return new Promise(resolve => {
      let handle: unknown
      const cleanup = (): void => {
        signal?.removeEventListener('abort', cancel)
        if (handle !== undefined) clock?.clearTimeout(handle)
      }
      const waiter: Waiter = {
        prev: undefined,
        next: undefined,
        queued: false,
        grant: release => {
          cleanup()
          resolve(release)
        },
      }
      const cancel = (): void => {
        if (!waiter.queued) return
        this.#remove(waiter)
        cleanup()
        resolve(undefined)
      }

      this.#push(waiter)
      signal?.addEventListener('abort', cancel, { once: true })
      if (maxWaitMs !== undefined && Number.isFinite(maxWaitMs) && clock) {
        handle = clock.setTimeout(cancel, maxWaitMs)
      }
    })
  }

  #push(waiter: Waiter): void {
    waiter.queued = true
    waiter.prev = this.#tail
    if (this.#tail) this.#tail.next = waiter
    else this.#head = waiter
    this.#tail = waiter
    this.#queued++
  }

  #remove(waiter: Waiter): void {
    if (waiter.prev) waiter.prev.next = waiter.next
    else this.#head = waiter.next
    if (waiter.next) waiter.next.prev = waiter.prev
    else this.#tail = waiter.prev
    waiter.prev = undefined
    waiter.next = undefined
    waiter.queued = false
    this.#queued--
  }

  #releaser(): Release {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#head
      if (!next) {
        this.#running--
        return
      }
      this.#remove(next)
      next.grant(this.#releaser())
    }
  }
}
