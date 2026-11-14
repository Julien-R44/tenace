import type { Temporal } from 'temporal-polyfill'

import { type Duration, toMs } from '../duration.ts'
import { macrotask, pendingYields } from '../internal/sleep.ts'
import { abortError } from './system_clock.ts'
import { temporal } from './temporal.ts'
import type { Deadline, TimeSource } from './types.ts'

type Timer = { at: number; fire: () => void; deadline: boolean }

/**
 * Waves of `yieldToEventLoop` a flush waits for at most: an endless loop of retries without
 * delay never stops yielding, and must not stop time from moving.
 */
const MAX_YIELD_WAVES = 100

/**
 * Lets the code run until it waits on a timer: pending promise callbacks, and the code that
 * yielded to the event loop (a retry yields every 100 retries without delay).
 */
async function flush(): Promise<void> {
  await new Promise<void>(macrotask)
  for (let wave = 0; pendingYields().size > 0 && wave < MAX_YIELD_WAVES; wave++) {
    await Promise.all(pendingYields())
    await new Promise<void>(macrotask)
  }
}

/**
 * The time of a faked clock, returned by `clock.fake()`. It stays still
 * until the test moves it, so waits and deadlines end only when the
 * test lets their time pass.
 *
 * Timers live in one queue ordered by due time. Timers due at the same
 * time fire in the order they were scheduled. Timers of `Infinity` never
 * fire.
 *
 * Disposing it restores the system time of the clock.
 *
 * @example
 * using time = clock.fake()
 * const waiting = time.nextWait()
 * const job = worker.start() // waits for 5 minutes between two runs
 *
 * await waiting
 * await time.advanceBy('5 minutes') // the worker runs once more
 */
export class FakeClock implements TimeSource, Disposable {
  #monotonic = 0
  #calendarOrigin: bigint
  #timers: Timer[] = []
  #nextWait = Promise.withResolvers<void>()
  #mode: 'idle' | 'manual' | 'automatic' | 'disposed' = 'idle'
  #driving = false
  #pendingWaits = new Set<Promise<void>>()
  #restore: () => void

  constructor(at: Temporal.Instant | Date, restore: () => void) {
    this.#calendarOrigin = toEpochNanoseconds(at)
    this.#restore = restore
  }

  /**
   * Restores the system time of the clock that created this fake
   */
  [Symbol.dispose](): void {
    if (this.#mode === 'disposed') return
    this.#mode = 'disposed'
    this.#timers = []
    this.#pendingWaits.clear()
    this.#restore()
  }

  /**
   * The deadlines that neither ended nor were disposed. A test can
   * assert it is zero to catch a deadline left behind.
   */
  get pendingDeadlines(): number {
    return this.#timers.filter(({ deadline }) => deadline).length
  }

  /**
   * The waits and deadlines that neither ended nor were cancelled.
   */
  get pendingTimers(): number {
    return this.#timers.length
  }

  now(): Temporal.Instant {
    return temporal.Instant.fromEpochNanoseconds(
      this.#calendarOrigin + BigInt(Math.round(this.#monotonic * 1_000_000)),
    )
  }

  monotonic(): number {
    return this.#monotonic
  }

  /**
   * Moves the calendar time to `at` without moving the monotonic time,
   * as a system clock adjustment does. No timer fires.
   */
  setTime(at: Temporal.Instant | Date): void {
    this.#calendarOrigin = toEpochNanoseconds(at) - BigInt(Math.round(this.#monotonic * 1_000_000))
  }

  /**
   * Moves both times forward by a finite `duration`, and fires the timers
   * due on the way in order. Promise continuations of what a timer ended
   * run before the next one fires. Rejects with a `RangeError` for a
   * negative, `NaN` or infinite duration. Await each advancement before
   * starting another one. Manual and automatic driving cannot be mixed.
   */
  async advanceBy(duration: Duration): Promise<void> {
    const milliseconds = toMs(duration)
    if (milliseconds === Number.POSITIVE_INFINITY) {
      throw new RangeError('Invalid duration: Infinity. advanceBy() expects a finite duration')
    }

    await this.#drive(async () => {
      const end = this.#monotonic + milliseconds
      await flush()

      while (this.#mode !== 'disposed' && this.#timers[0] && this.#timers[0].at <= end) {
        this.#fireNext()
        await flush()
      }

      if (this.#mode !== 'disposed') this.#monotonic = end
    })
  }

  /**
   * Fires every timer, including the ones scheduled while running, until
   * none is left but the ones of `Infinity`. Rejects after `limit` timers
   * to surface an endless loop of timers.
   */
  async runAll(limit = 10_000): Promise<void> {
    await this.#drive(async () => {
      await flush()

      for (let fired = 0; this.#mode !== 'disposed' && this.#hasDueTimer(); fired++) {
        if (fired >= limit) throw new Error(`runAll() fired more than ${limit} timers`)
        this.#fireNext()
        await flush()
      }
    })
  }

  /**
   * From now on, each wait moves the time to its end at once, firing
   * the timers due on the way, deadlines included. Waits already pending
   * end too. Use it when the code under test does real I/O between two
   * waits, where `advanceBy` cannot tell when the I/O is done. Once
   * enabled, `advanceBy` and `runAll` reject instead of competing with it.
   */
  letTimePass(): this {
    if (this.#mode === 'manual') throw new Error('FakeClock is already being advanced')
    if (this.#mode === 'disposed') throw new Error('FakeClock has been disposed')
    this.#mode = 'automatic'
    void this.#pass()
    return this
  }

  /**
   * Resolves when the next wait starts. Call it before starting the
   * operation that will wait.
   */
  nextWait(): Promise<void> {
    return this.#nextWait.promise
  }

  wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    const wait = new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        dispose()
        reject(abortError(signal!))
      }
      const dispose = this.#schedule(milliseconds, false, () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      })

      if (signal?.aborted) {
        abort()
      } else {
        signal?.addEventListener('abort', abort, { once: true })
      }
    })

    this.#pendingWaits.add(wait)
    const forget = (): boolean => this.#pendingWaits.delete(wait)
    wait.then(forget, forget)

    this.#nextWait.resolve()
    this.#nextWait = Promise.withResolvers<void>()

    if (this.#mode === 'automatic') {
      void this.#pass()
    }

    return wait
  }

  timeout(milliseconds: number): Deadline {
    const controller = new AbortController()
    const dispose = this.#schedule(milliseconds, true, () => {
      controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'))
    })

    return { signal: controller.signal, [Symbol.dispose]: dispose }
  }

  async #drive(run: () => Promise<void>): Promise<void> {
    if (this.#mode === 'automatic') throw new Error('FakeClock is in automatic mode')
    if (this.#mode === 'manual') throw new Error('FakeClock is already being advanced')
    if (this.#mode === 'disposed') throw new Error('FakeClock has been disposed')

    this.#mode = 'manual'
    try {
      await run()
    } finally {
      if (this.#mode === 'manual') this.#mode = 'idle'
    }
  }

  /**
   * The one loop that moves the time while a wait is pending. It fires
   * the next timer, then lets the continuations of what ended run, such
   * as a deadline disposed once its wait ended, before it moves again.
   */
  async #pass(): Promise<void> {
    if (this.#driving) {
      return
    }

    this.#driving = true
    try {
      await flush()

      while (this.#mode === 'automatic' && this.#pendingWaits.size > 0 && this.#hasDueTimer()) {
        this.#fireNext()
        await flush()
      }
    } finally {
      this.#driving = false
    }
  }

  #hasDueTimer(): boolean {
    return this.#timers[0] !== undefined && this.#timers[0].at !== Number.POSITIVE_INFINITY
  }

  #fireNext(): void {
    const timer = this.#timers.shift()!
    this.#monotonic = timer.at
    timer.fire()
  }

  /**
   * Queues a timer after the ones due at the same time or earlier, and
   * returns the function that cancels it.
   */
  #schedule(milliseconds: number, deadline: boolean, fire: () => void): () => void {
    const timer = { at: this.#monotonic + (milliseconds > 0 ? milliseconds : 0), fire, deadline }
    const index = this.#timers.findIndex(({ at }) => at > timer.at)
    this.#timers.splice(index === -1 ? this.#timers.length : index, 0, timer)

    return () => {
      this.#timers = this.#timers.filter(pending => pending !== timer)
    }
  }
}

function toEpochNanoseconds(at: Temporal.Instant | Date): bigint {
  return at instanceof Date ? BigInt(at.getTime()) * 1_000_000n : at.epochNanoseconds
}
