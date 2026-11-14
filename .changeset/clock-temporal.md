---
'@julr/tenace': major
---

One `Clock` for every policy, with Temporal dates, deadlines, and a fake time for tests. It replaces the `Clock` interface, `systemClock`, `TestClock`, and `waitFor`.

- `clock.now()` returns a `Temporal.Instant`, the calendar time. `clock.monotonic()` returns milliseconds on a clock that never jumps, for durations.
- `clock.wait(duration, signal?)` resolves once the duration passes, and `clock.timeout(duration)` returns a deadline, `{ signal } & Disposable`.
- `clock.waitFor(condition, options?)` waits for a boolean or `Result<boolean, E>` and returns `Result<void, E | TimeoutError | CancelledError | UnexpectedError>`.
- `clock.poll(observe, { until, ...options })` returns the unwrapped observation accepted by the predicate. No value is a sentinel. Both methods retain `timeout`, `interval`, `signal`, the defaults of 10 seconds and 100ms, and the `{ signal, attempt }` callback context. Business errors are preserved. Exceptions, invalid arguments, timeouts, and cancellation become error Results.
- `clock.fake(at?)` replaces the time of a clock with a `FakeClock`: `advanceBy`, `runAll`, `setTime`, `letTimePass`, `nextWait`, `pendingTimers`, and `pendingDeadlines`. Dispose it with `using`, or call `clock.restore()`.
- Every policy reads the shared `clock` exported by `@julr/tenace`, circuit breakers included, so one `clock.fake()` drives the timeouts, the retries, and the circuit breakers.

`Temporal` is the native API where available, including Node.js 26, Bun, and recent Workers with the `temporal` flag. Otherwise Tenace dynamically imports the `temporal-polyfill` ponyfill, including for AdonisJS on Node.js 24. It does not modify `globalThis`. `temporal-polyfill` is the first runtime dependency of the package.

### Breaking changes

- The `Clock` interface (`now()` in epoch milliseconds, `setTimeout`, `clearTimeout`) is now the `Clock` class. The `clock` options of `execute()`, `settle()`, batches, `CircuitBreaker`, `RateLimit`, `RetryBudget`, and `Lock` take a `Clock`, such as `new Clock()`.
- `systemClock` and `TimerHandle` are removed. Use the shared `clock`.
- `TestClock` is removed from `@julr/tenace/testing`. Call `clock.fake()`, then `time.advanceBy()` instead of `advance()`. `runAll()` and `pendingTimers` are unchanged. `@julr/tenace/testing` now exports the `FakeClock` class.

  ```ts
  // before
  const clock = new TestClock()
  const done = policy.settle(fn, { clock })
  await clock.advance('1s')

  // after
  using time = clock.fake()
  const done = policy.settle(fn)
  await time.advanceBy('1s')
  ```

- `clock.fake()` starts at the current date, unlike `new TestClock()`, which started at epoch zero. Pass `clock.fake(new Date(0))` for deterministic epoch assertions. The starting date accepts `Date` or `Temporal.Instant`, not numeric epoch milliseconds. Read `now().epochMilliseconds` for calendar milliseconds and `monotonic()` for elapsed time.
- A `CircuitBreaker` without a `clock` option reads the shared `clock` instead of the system time, so faking it drives the breaker too.
- `waitFor` and `Tenace.waitFor` are removed. Use `clock.waitFor()` with the same boolean condition and interval options. It returns a Result instead of rejecting, including for external cancellation. Check the Result or unwrap it explicitly. For an isolated clock, call the method on that instance instead of passing a `clock` option.

  ```ts
  // before
  await waitFor(() => isReady(), { interval: '500ms', timeout: '30s' })

  // after
  const ready = await clock.waitFor(() => isReady(), {
    timeout: '30s',
    interval: '500ms',
  })
  Result.unwrap(ready) // import Result from '@julr/tenace'
  ```

- Both polling methods dispose their timers on exit and cancel work at timeout or failure. `waitFor()` also aborts its callback signal on success. `poll()` keeps it live on success so a returned resource remains usable and linked to the caller's signal. Later resource use and detached tasks are outside the Result guarantee.
- A Clock permits one active fake. Restore it before creating another. Restoration stops its driver and discards pending timers without resolving the abandoned waits. Use either manual or automatic time; overlapping manual advancements and manual operations after `letTimePass()` reject. Arm `nextWait()` before starting the operation that waits.
- A custom strategy waits with `context.clock.wait()` or `context.clock.timeout()` instead of `context.clock.setTimeout()`, and measures durations with `context.clock.monotonic()`.
