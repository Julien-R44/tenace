import type { Clock, TimerHandle } from '../clock.ts'
import { type Duration, toMs } from '../duration.ts'
import { macrotask, pendingYields } from '../internal/sleep.ts'

interface Timer {
  readonly id: number
  readonly at: number
  readonly callback: () => void
}

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
   * Rejects with a `RangeError` for a negative, `NaN` or infinite duration.
   */
  async advance(duration: Duration): Promise<void> {
    const ms = toMs(duration)
    if (ms === Number.POSITIVE_INFINITY) {
      throw new RangeError(
        'Invalid duration: Infinity. TestClock.advance() expects a finite duration',
      )
    }
    const target = this.#now + ms
    await flush()

    for (;;) {
      const next = this.#nextDue(target)
      if (!next) break
      this.#timers = this.#timers.filter(timer => timer !== next)
      this.#now = next.at
      next.callback()
      await flush()
    }

    this.#now = target
  }

  /**
   * Fires every timer, including the ones scheduled while running, until none is left
   * (except the ones of `Infinity`). Rejects after `limit` timers to surface infinite timer loops.
   */
  async runAll(limit = 10_000): Promise<void> {
    await flush()
    for (let fired = 0; ; fired++) {
      const next = this.#nextDue(Number.MAX_VALUE) // timers of `Infinity` never fire
      if (!next) break
      if (fired >= limit) throw new Error(`TestClock.runAll() fired more than ${limit} timers`)
      this.#timers = this.#timers.filter(timer => timer !== next)
      this.#now = Math.max(this.#now, next.at)
      next.callback()
      await flush()
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
