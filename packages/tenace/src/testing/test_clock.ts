import type { Clock, TimerHandle } from '../clock.ts'
import { type Duration, toMs } from '../duration.ts'

interface Timer {
  readonly id: number
  readonly at: number
  readonly callback: () => void
}

const flushMacrotask = (): Promise<void> =>
  new Promise(resolve => globalThis.setTimeout(resolve, 0))

/**
 * Manually driven clock for tests. Time only moves with `advance()` / `runAll()`. Timers of
 * `Infinity` never fire, `NaN` delays fire right away.
 *
 * ```ts
 * const clock = new TestClock()
 * const done = policy.execute(fn, { clock })
 * await clock.advance('1s')
 * ```
 */
export class TestClock implements Clock {
  #now: number
  #nextId = 1
  #timers: Timer[] = []

  constructor(startAt = 0) {
    this.#now = startAt
  }

  /**
   * Number of timers waiting to fire.
   */
  get pendingTimers(): number {
    return this.#timers.length
  }

  now(): number {
    return this.#now
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const timer: Timer = { id: this.#nextId++, at: this.#now + (ms > 0 ? ms : 0), callback }
    this.#timers.push(timer)
    return timer.id
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers = this.#timers.filter(timer => timer.id !== handle)
  }

  /**
   * Moves time forward by a finite duration, firing due timers in order. Pending promise
   * callbacks run between timers, so timers scheduled by fired timers are honored too.
   */
  async advance(duration: Duration): Promise<void> {
    const ms = toMs(duration)
    if (ms === Number.POSITIVE_INFINITY) {
      throw new RangeError(
        'Invalid duration: Infinity. TestClock.advance() expects a finite duration',
      )
    }
    const target = this.#now + ms
    await flushMacrotask()

    for (;;) {
      const next = this.#nextDue(target)
      if (!next) break
      this.#timers = this.#timers.filter(timer => timer !== next)
      this.#now = next.at
      next.callback()
      await flushMacrotask()
    }

    this.#now = target
  }

  /**
   * Fires every timer, including the ones scheduled while running, until none is left
   * (except the ones of `Infinity`). Throws after `limit` timers to surface infinite timer loops.
   */
  async runAll(limit = 10_000): Promise<void> {
    await flushMacrotask()
    for (let fired = 0; ; fired++) {
      const next = this.#nextDue(Number.MAX_VALUE) // timers of `Infinity` never fire
      if (!next) break
      if (fired >= limit) throw new Error(`TestClock.runAll() fired more than ${limit} timers`)
      this.#timers = this.#timers.filter(timer => timer !== next)
      this.#now = Math.max(this.#now, next.at)
      next.callback()
      await flushMacrotask()
    }
  }

  #nextDue(until: number): Timer | undefined {
    let next: Timer | undefined
    for (const timer of this.#timers) {
      if (timer.at > until) continue
      if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer
    }
    return next
  }
}
