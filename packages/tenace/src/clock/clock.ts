import type { Temporal } from 'temporal-polyfill'

import type { Context } from '../context.ts'
import { type Duration, toMs } from '../duration.ts'
import { CancelledError, TimeoutError, UnexpectedError } from '../errors.ts'
import type { HandlerError, ValueOfReturn } from '../fold.ts'
import { raceAbort } from '../internal/race_signal.ts'
import { Result } from '../result/namespace.ts'
import { FakeClock } from './fake_clock.ts'
import { SystemClock } from './system_clock.ts'
import type {
  Deadline,
  PollOptions,
  TimerOptions,
  TimeSource,
  WaitForOptions,
  WaitOptions,
} from './types.ts'

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
   *
   * @example
   * await clock.wait('1s', { signal })
   */
  wait(duration: Duration, options?: WaitOptions): Promise<void> {
    return this.#source.wait(toMs(duration), options)
  }

  /**
   * Starts a deadline whose signal aborts with a `TimeoutError` once
   * the duration passes. Dispose it when the work it bounds ends. With
   * `ref: false`, the pending deadline does not keep the process alive.
   *
   * @example
   * using deadline = clock.timeout('5s')
   * await client.query(sql, { signal: deadline.signal })
   */
  timeout(duration: Duration, options?: TimerOptions): Deadline {
    return this.#source.timeout(toMs(duration), options)
  }

  /**
   * Waits for a boolean condition, or a Result containing one. False
   * tries again; true returns `Result.ok()`. A returned error is preserved.
   * Timeouts, cancellation and thrown values also return error Results.
   * Defaults to a 10-second timeout and a 100ms interval.
   * The condition's signal aborts when this operation ends, success included.
   * `ref: false` applies to its deadline and its pauses alike.
   *
   * @example
   * const ready = await clock.waitFor(
   *   ({ signal }) => deployment.isHealthy({ signal }),
   *   { timeout: '2 minutes', interval: '5s' }
   * )
   * Result.unwrap(ready) // explicitly propagate a failure by throwing
   */
  waitFor<R>(
    condition: (
      context: Context,
    ) => R & (ValueOfReturn<Awaited<R>> extends boolean ? unknown : never),
    options?: WaitForOptions,
  ): Promise<
    Result<void, HandlerError<Awaited<R>> | TimeoutError | CancelledError | UnexpectedError>
  >
  waitFor<E = never>(
    condition: (
      context: Context,
    ) => boolean | Result<boolean, E> | PromiseLike<boolean | Result<boolean, E>>,
    options?: WaitForOptions,
  ): Promise<Result<void, E | TimeoutError | CancelledError | UnexpectedError>>
  async waitFor<R>(
    condition: (context: Context) => R,
    options: WaitForOptions = {},
  ): Promise<
    Result<void, HandlerError<Awaited<R>> | TimeoutError | CancelledError | UnexpectedError>
  > {
    const controller = new AbortController()
    try {
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal
      const result = await this.poll<R>(condition, {
        ...options,
        timeoutMode: 'strict',
        signal,
        until: value => {
          if (typeof value !== 'boolean')
            throw new TypeError('waitFor() expects a boolean condition')
          return value
        },
      })
      return result.ok ? Result.ok() : result
    } catch (cause) {
      return Result.err(new UnexpectedError(cause))
    } finally {
      controller.abort()
    }
  }

  /**
   * Observes immediately, then after each interval until the predicate
   * accepts the unwrapped value. No value is a sentinel: false, null,
   * undefined and zero are ordinary observations.
   *
   * All outcomes are Results. By default, the timeout covers observations
   * that ignore their signal too. `timeoutMode: 'finish-current'` lets the
   * current observation and predicate finish, accepting a late success
   * without starting another observation after the deadline. Caller cancellation
   * still ends the poll immediately. A successful value keeps a live signal,
   * still linked to the caller, so resources such as Response bodies remain usable.
   * `ref: false` applies to its deadline and its pauses alike.
   *
   * @example
   * const job = await clock.poll(
   *   ({ signal }) => queue.find(id, { signal }),
   *   { until: job => job.done, timeout: '2m', interval: '500ms' }
   * )
   */
  async poll<R>(
    observe: (context: Context) => R,
    options: PollOptions<ValueOfReturn<Awaited<R>>>,
  ): Promise<
    Result<
      ValueOfReturn<Awaited<R>>,
      HandlerError<Awaited<R>> | TimeoutError | CancelledError | UnexpectedError
    >
  > {
    const controller = new AbortController()
    let caller: AbortSignal | undefined
    let deadline: Deadline | undefined
    let timeoutError: TimeoutError | undefined
    let timeout = 0
    let finishCurrent = false
    let end = Number.POSITIVE_INFINITY
    let succeeded = false
    let failure: unknown

    try {
      caller = options.signal
      caller?.throwIfAborted()
      if (typeof observe !== 'function')
        throw new TypeError('poll() expects an observation function')
      if (typeof options.until !== 'function')
        throw new TypeError('poll() expects an until predicate')
      const timeoutMode = options.timeoutMode ?? 'strict'
      if (timeoutMode !== 'strict' && timeoutMode !== 'finish-current') {
        throw new RangeError(`Invalid timeoutMode: ${String(timeoutMode)}`)
      }
      finishCurrent = timeoutMode === 'finish-current'

      timeout = toMs(options.timeout ?? '10s')
      const interval = options.interval ?? 100
      if (typeof interval !== 'function') toMs(interval)
      end = this.monotonic() + timeout
      timeoutError = new TimeoutError(timeout)
      deadline = this.timeout(timeout, { ref: options.ref })
      const signal = AbortSignal.any([
        controller.signal,
        ...(finishCurrent ? [] : [deadline.signal]),
        ...(caller ? [caller] : []),
      ])
      const waitSignal = finishCurrent ? AbortSignal.any([signal, deadline.signal]) : signal
      // A synchronous callback can hold up the deadline timer. A zero budget
      // still permits one immediate observation, even on the system clock.
      const expired = (): boolean =>
        deadline!.signal.aborted || (timeout > 0 && this.monotonic() >= end)

      for (let attempt = 1; ; attempt++) {
        const result = (await raceAbort(
          async () => Result.try(() => observe({ signal, attempt })),
          signal,
        )) as Result<ValueOfReturn<Awaited<R>>, HandlerError<Awaited<R>> | UnexpectedError>
        caller?.throwIfAborted()
        if (!finishCurrent && expired()) throw timeoutError

        if (!result.ok) {
          failure = result.error
          return result
        }

        const ready = await raceAbort(async () => options.until(result.value), signal)
        if (typeof ready !== 'boolean') throw new TypeError('poll() expects a boolean predicate')
        caller?.throwIfAborted()
        if (!finishCurrent && expired()) throw timeoutError

        if (ready) {
          succeeded = true
          return result
        }

        const left = end - this.monotonic()
        if (left <= 0) throw timeoutError
        const pause = Math.max(
          toMs(typeof interval === 'function' ? interval(attempt) : interval),
          1,
        )
        await this.wait(Math.min(pause, left), { signal: waitSignal, ref: options.ref }).catch(
          cause => {
            if (deadline!.signal.aborted) throw timeoutError
            throw cause
          },
        )
        caller?.throwIfAborted()
        if (expired()) throw timeoutError
      }
    } catch (cause) {
      const error = caller?.aborted
        ? new CancelledError(caller.reason)
        : timeoutError &&
            (cause === timeoutError ||
              (!finishCurrent &&
                (deadline?.signal.aborted || (timeout > 0 && this.monotonic() >= end))))
          ? timeoutError
          : new UnexpectedError(cause)
      failure = error
      return Result.err(error)
    } finally {
      deadline?.[Symbol.dispose]()
      if (!succeeded) controller.abort(failure)
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
    if (this.#source instanceof FakeClock) {
      throw new Error('Clock is already faked; restore it before creating another fake')
    }
    const fake = new FakeClock(at ?? this.now(), () => {
      if (this.#source === fake) this.restore()
    })
    this.#source = fake
    return fake
  }

  /**
   * Goes back to the system time. Waits still pending on the fake time
   * never resolve.
   */
  restore(): void {
    const source = this.#source
    this.#source = this.#system
    if (source instanceof FakeClock) source[Symbol.dispose]()
  }
}

/**
 * The clock every policy reads the time from, unless an execution gets
 * its own with `execute(fn, { clock })`. Fake it in tests with
 * `clock.fake()`.
 */
export const clock: Clock = new Clock()
