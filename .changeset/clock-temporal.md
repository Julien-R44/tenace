---
'@julr/tenace': major
---

One `Clock` for every policy, with Temporal dates, deadlines, and a fake time for tests. It replaces the `Clock` interface, `systemClock`, `TestClock`, and `waitFor`.

- `clock.now()` returns a `Temporal.Instant`, the calendar time. `clock.monotonic()` returns milliseconds on a clock that never jumps, for durations.
- `clock.wait(duration, signal?)` resolves once the duration passes, and `clock.timeout(duration)` returns a deadline, `{ signal } & Disposable`.
- `clock.until(observe, { within, every, signal? })` observes until a value comes, and returns it, or `null` once `within` passes. `every` also accepts a backoff.
- `clock.fake(at?)` replaces the time of a clock with a `FakeClock`: `advanceBy`, `runAll`, `setTime`, `letTimePass`, `nextWait`, `pendingTimers`, and `pendingDeadlines`. Dispose it with `using`, or call `clock.restore()`.
- Every policy reads the shared `clock` exported by `@julr/tenace`, circuit breakers included, so one `clock.fake()` drives the timeouts, the retries, and the circuit breakers.

`Temporal` is the native API where the runtime has one (Node.js 26, Bun), else the `temporal-polyfill` ponyfill (Node.js 22 and 24, Cloudflare Workers), which is not installed on `globalThis`. `temporal-polyfill` is the first runtime dependency of the package.

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

- A `CircuitBreaker` without a `clock` option reads the shared `clock` instead of the system time, so faking it drives the breaker too.
- `waitFor` and `Tenace.waitFor` are removed. Use `clock.until()`: return `undefined` when not ready, since `false` is a value. It returns `null` at the deadline instead of rejecting with a `TimeoutError`, and has no default `within` or `every`.

  ```ts
  // before
  await waitFor(() => isReady(), { interval: '500ms', timeout: '30s' })

  // after
  const ready = await clock.until(async () => ((await isReady()) ? true : undefined), {
    within: '30s',
    every: '500ms',
  })
  if (ready === null) throw new Error('not ready after 30s')
  ```

- A custom strategy waits with `context.clock.wait()` or `context.clock.timeout()` instead of `context.clock.setTimeout()`, and measures durations with `context.clock.monotonic()`.
