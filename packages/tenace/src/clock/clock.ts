import type { Temporal } from 'temporal-polyfill'

import { type Duration, toMs } from '../duration.ts'
import { raceAbort } from '../internal/race_signal.ts'
import { FakeClock } from './fake_clock.ts'
import { SystemClock } from './system_clock.ts'
import type { Deadline, TimeSource, UntilOptions } from './types.ts'

/**
 * Reads the time and waits for it to pass. Code that depends on time
 * reads it from the clock, so tests can freeze and move it with
 * `clock.fake()`. Every policy reads the time from a clock: the shared
 * `clock` by default, or the one given to `execute(fn, { clock })`.
 *
 * The clock keeps two times apart:
 * - `now()` is the calendar time, for dates stored or shown to users.
 * - `monotonic()` never jumps, and measures durations and deadlines.
 *
 * @example
 * import { clock } from '@julr/tenace'
 *
 * const expiresAt = clock.now().add({ hours: 2 })
 *
 * using deadline = clock.timeout('30 seconds')
 * await fetch(url, { signal: deadline.signal })
 */
export class Clock {
  readonly #system = new SystemClock()
  #source: TimeSource = this.#system

  /**
   * The current calendar time
   */
  now(): Temporal.Instant {
    return this.#source.now()
  }

  /**
   * Milliseconds on a clock that only moves forward, for measuring
   * durations. Its origin is unspecified, compare two readings only.
   */
  monotonic(): number {
    return this.#source.monotonic()
  }

  /**
   * Resolves once the duration passes. Rejects with an `AbortError`
   * when the signal aborts first. A wait of `Infinity` only ends with
   * the signal.
   */
  wait(duration: Duration, signal?: AbortSignal): Promise<void> {
    return this.#source.wait(toMs(duration), signal)
  }

  /**
   * Starts a deadline whose signal aborts with a `TimeoutError` once
   * the duration passes. Dispose it when the work it bounds ends.
   *
   * @example
   * using deadline = clock.timeout('5s')
   * await client.query(sql, { signal: deadline.signal })
   */
  timeout(duration: Duration): Deadline {
    return this.#source.timeout(toMs(duration))
  }

  /**
   * Calls `observe` every `every` until it returns a value other than
   * `undefined`, and returns that value. Returns `null` once `within`
   * passes, even when the deadline cuts an observation short: the
   * signal given to `observe` aborts at the deadline and with the
   * caller.
   *
   * When the caller aborts, its reason is thrown. A value observed after
   * the caller aborted or the deadline passed is dropped, so an
   * observation that ignores its signal cannot outlive them.
   *
   * @example
   * const server = await clock.until(
   *   async (signal) => {
   *     const server = await provider.find(id, { signal })
   *     return server.ready ? server : undefined
   *   },
   *   { within: '2 minutes', every: '5s' }
   * )
   */
  async until<T>(
    observe: (signal: AbortSignal) => T | undefined | Promise<T | undefined>,
    options: UntilOptions,
  ): Promise<T | null> {
    options.signal?.throwIfAborted()

    const within = toMs(options.within)
    const every = options.every
    if (typeof every !== 'function') toMs(every)
    const end = this.monotonic() + within

    using deadline = this.timeout(within)
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal

    // the deadline timer cannot fire during a slow synchronous observation. A
    // budget of 0 checks once, and relies on the timer alone: two readings of
    // the system time always differ
    const expired = (): boolean => deadline.signal.aborted || (within > 0 && this.monotonic() > end)

    try {
      let attempt = 0
      do {
        // settles at the deadline or with the caller even when `observe` ignores its signal
        const value = await raceAbort(async () => observe(signal), signal)
        options.signal?.throwIfAborted()

        if (expired()) {
          return null
        }

        if (value !== undefined) {
          return value
        }

        attempt++
        // at least 1ms, so a pause of 0 cannot stop a fake time from moving
        const pause = Math.max(toMs(typeof every === 'function' ? every(attempt) : every), 1)
        const left = end - this.monotonic()
        if (left > 0) {
          await this.wait(Math.min(pause, left), signal)
        }
      } while (this.monotonic() < end)

      return null
    } catch (error) {
      options.signal?.throwIfAborted()

      if (expired()) {
        return null
      }

      throw error
    }
  }

  /**
   * Replaces the system time with a fake one, frozen at `at` (defaults
   * to the current time) until the returned FakeClock moves it. Every
   * consumer of this clock, injected or imported, sees the fake time:
   * the policies, their timeouts, retries and circuit breakers included.
   *
   * Hold the fake with `using` to restore the system time at the end of
   * the scope, or call `clock.restore()`.
   *
   * @example
   * using time = clock.fake(new Date('2026-01-01T00:00:00Z'))
   * await time.advanceBy('2 hours')
   */
  fake(at?: Temporal.Instant | Date): FakeClock {
    const fake = new FakeClock(at ?? this.now(), () => this.restore())
    this.#source = fake
    return fake
  }

  /**
   * Goes back to the system time. Waits still pending on the fake time
   * never resolve.
   */
  restore(): void {
    this.#source = this.#system
  }
}

/**
 * The clock every policy reads the time from, unless an execution gets
 * its own with `execute(fn, { clock })`. Fake it in tests with
 * `clock.fake()`.
 */
export const clock: Clock = new Clock()
