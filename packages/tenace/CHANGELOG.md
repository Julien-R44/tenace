# Changelog

## 3.0.0

### Major Changes

- [#4](https://github.com/Julien-R44/tenace/pull/4) [`524b66d`](https://github.com/Julien-R44/tenace/commit/524b66deae2fc99ceb32c5e60e7da4cacd111f57) Thanks [@RomainLanz](https://github.com/RomainLanz)! - One `Clock` for every policy, with Temporal dates, deadlines, and a fake time for tests. It replaces the `Clock` interface, `systemClock`, `TestClock`, and `waitFor`.

  Follow the [v2 to v3 migration guide](https://tenace.julr.dev/guides/migrate-clock/) for before-and-after examples of every removed API and the changes to error handling.

  - `clock.now()` returns a `Temporal.Instant`, the calendar time. `clock.monotonic()` returns milliseconds on a clock that never jumps, for durations.
  - `clock.wait(duration, { signal? })` resolves once the duration passes, and `clock.timeout(duration)` returns a deadline, `{ signal } & Disposable`.
  - `ref: false` lets the process exit while only Tenace timers are pending, like `timer.unref()`. Pass it to `clock.wait()`, `clock.timeout()`, `clock.waitFor()`, `clock.poll()`, `execute()`, `settle()`, and batches, which apply it to every timer of their strategies. Timers keep the process alive by default.
  - `clock.waitFor(condition, options?)` waits for a boolean or `Result<boolean, E>` and returns `Result<void, E | TimeoutError | CancelledError | UnexpectedError>`.
  - `clock.poll(observe, { until, ...options })` returns the unwrapped observation accepted by the predicate. No value is a sentinel. Both methods retain `timeout`, `interval`, `signal`, the defaults of 10 seconds and 100ms, and the `{ signal, attempt }` callback context. Business errors are preserved. Exceptions, invalid arguments, timeouts, and cancellation become error Results.
  - `clock.poll()` accepts `timeoutMode: 'finish-current'` to let the current observation and predicate finish without aborting their signal at the deadline. It keeps an accepted late value, preserves errors, and starts no further observations once the budget expires. Caller cancellation still ends the poll immediately. A stalled callback can exceed the budget indefinitely. The default mode remains `strict`.
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

  - Both polling methods dispose their timers on exit and cancel work at timeout or failure. In `finish-current` mode, `poll()` defers the timeout until the current observation and predicate finish. `waitFor()` also aborts its callback signal on success. `poll()` keeps it live on success so a returned resource remains usable and linked to the caller's signal. Later resource use and detached tasks are outside the Result guarantee.
  - A Clock permits one active fake. Restore it before creating another. Restoration stops its driver and discards pending timers without resolving the abandoned waits. Use either manual or automatic time; overlapping manual advancements and manual operations after `letTimePass()` reject. Arm `nextWait()` before starting the operation that waits.
  - A custom strategy waits with `context.clock.wait()` or `context.clock.timeout()` instead of `context.clock.setTimeout()`, and measures durations with `context.clock.monotonic()`.

## 2.0.1

### Patch Changes

- [#2](https://github.com/Julien-R44/tenace/pull/2) [`869f954`](https://github.com/Julien-R44/tenace/commit/869f954e5a52c36281fed10e3f28b5dc84d5e5c7) Thanks [@Julien-R44](https://github.com/Julien-R44)! - Duration strings support long unit names, spaces, case-insensitive aliases, weeks, years, and unitless milliseconds. Parsing uses code adapted from `@lukeed/ms` under the MIT license, with no runtime dependency.

  `Duration` accepts `string | number`, including values read from configuration. Strings such as `'0s'`, `'+1s'`, and `'1e3ms'` are valid. Negative, malformed, and overflowing string durations throw a `RangeError`.

## 2.0.0

### Major Changes

- [`6d3bfd8`](https://github.com/Julien-R44/tenace/commit/6d3bfd87f7fdb6ac025b733ec58b8ac58b19bae7) Thanks [@Julien-R44](https://github.com/Julien-R44)! - Tenace 2: typed errors, `execute()` and `settle()`, and no runtime dependencies. See the notes below for everything that changed.

Tenace 2 is a rewrite. The library no longer wraps cockatiel and has no runtime dependencies. The API changed everywhere: see [Breaking changes](#breaking-changes) below.

### Highlights

- **Typed error channel.** A policy knows which errors it can produce. `.withTimeout()` adds `TimeoutError`, `.withFallbackOn(['TimeoutError'], ...)` removes it, and functions returning `Result.err(...)` add their own errors. `ErrorOf<typeof policy>` gives the union.
- **`execute()` or `settle()`.** `execute()` resolves with the value or rejects. `settle()` resolves with a typed `Result`, and `Result.match()` handles each error tag exhaustively.
- **One composition operator.** `.with(x)` adds a strategy or inlines another policy. Policies are immutable. Stateful strategies (circuit breakers, bulkheads, rate limits) are shared by identity between the policies that use them.
- **Custom strategies.** Extend `Strategy<Adds, Removes>` to write your own, with the same typing as the built-in ones.
- **Results without policies.** `Result` is both a type and a namespace: `Result.ok()`, `Result.err()`, `Result.match()`, plus `Result.try()` to wrap code that throws, `Result.all()` and `Result.partition()` to combine Results, and `Result.unwrap()` / `Result.unwrapErr()`. Import it from `@julr/tenace/result` to load only the Results and the error classes.
- **Your own Result type.** Augment `ResultTypes` and call `registerResult()` to unwrap a Result library you already use.

### Strategies

- **Timeout**: aggressive (default) or cooperative. Durations accept milliseconds or strings such as `'1.5s'`.
- **Retry**:
  - `backoff.constant`, `linear`, `exponential` with full or equal jitter;
  - `retryOn` by tag, `retryIf`, and `retryIfValue` to retry successful values such as a `503` response;
  - honors the `retryAfterMs` of an error (rate limits, open circuits listed in `retryOn`), capped by `maxDelay`;
  - does not retry an open circuit, unless `retryOn` lists `CircuitOpenError`;
  - a shared `RetryBudget` against retry storms;
  - an idempotency rule: with `execute(fn, { idempotent: false })`, only calls rejected before running are retried.
- **Circuit breaker**:
  - consecutive, count-window and time-window trips;
  - configurable half-open (permits, successes, max wait);
  - `openFor` as a duration or a backoff;
  - `isolate()` to force it open;
  - a pluggable `CircuitBreakerStore` for distributed state, with the state machine exported as `circuitBreakerMachine`.
- **Bulkhead**: concurrency limit with a FIFO queue and `maxWait`.
- **Rate limit**: in-memory token bucket, or any store. A `rate-limiter-flexible` adapter is included.
- **Lock**: in-process by default, or any provider. A `@verrou/core` adapter is included.
- **Dedupe**: concurrent executions with the same key share one run.
- **Cache**: any provider, with a `bentocache` adapter included. Only successes are cached, and the cache fails open.
- **Stale fallback**: serves the last success of a key when the call fails.
- **Fallbacks**: `withFallback`, `withFallbackOn(tags)`, `withFallbackWhen(predicate)`, and `mapError`.
- **Chaos**: `withChaos()` injects latency, throws, errors or values into one policy. `Tenace.chaos()` injects latency and throws into every policy.

### Batches

`Tenace.all(tasks, options)` and `Tenace.map(items, fn, options)` run functions through a policy with bounded concurrency:

- `.execute()` fails fast: it aborts the running tasks and skips the others;
- `.settle()` returns one typed Result per task.

### Waiting for a condition

`waitFor(condition, options)` polls a condition until it returns `true`, with an interval (a duration or a backoff), a timeout, a signal and a clock. `condition` receives a signal aborted when the wait ends.

### Observability

- **Instrumentation contract**: around-advice on executions and attempts, plus events, through `Tenace.instrument()` globally or the `instrumentation` option of a policy.
- **`listener()` and `combine()`** helpers.
- **`node:diagnostics_channel`**: executions are published on `tracing:tenace:execution`, `tracing:tenace:attempt` and `tenace:event` when something subscribes.
- **OpenTelemetry**: traces and metrics through the new [`@julr/tenace-otel`](../tenace-otel) package.
- **No cost when unobserved**: executions nobody observes skip every hook.

### Testing

- `TestClock` from `@julr/tenace/testing` drives timeouts, retries, rate limits and breakers without real timers.
- `Tenace.chaos()` returns a restore function, and nested settings restore in any order.

### Runtimes and packaging

- ESM only, Node.js 22.18 or later, Bun, and Cloudflare Workers (with or without `nodejs_compat`). There are no static `node:` imports.
- One module per source file, so a bundler only keeps what you import: `Result` alone weighs about 1 kB gzipped.

### Breaking changes

| 1.x                                                                                         | 2.0                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policy.call(fn)`                                                                           | `policy.execute(fn)` or `policy.settle(fn)`                                                                                                                                                      |
| the `attempt` of the context starts at 0                                                    | it starts at 1                                                                                                                                                                                   |
| `CircuitOpenError` and `BulkheadFullError` are never retried                                | `BulkheadFullError`, `RateLimitError` and `LockNotAcquiredError` are retried by default, a `RateLimitError` after its `retryAfterMs`. `CircuitOpenError` is retried only when `retryOn` lists it |
| `.withRetry()`, `.withRetry({ times })`, 3 retries by default                               | `.withRetry({ retries })`, `retries` is required                                                                                                                                                 |
| `backoff.exponential({ initial, exponent })`, no jitter                                     | `backoff.exponential({ base, factor, max, jitter })`, full jitter by default                                                                                                                     |
| `backoff.exponentialWithJitter(...)`                                                        | `backoff.exponential({ jitter: 'full' \| 'equal' })`                                                                                                                                             |
| `backoff.linear({ initial, step })`                                                         | `backoff.linear({ base, max, jitter })`: `base * attempt`                                                                                                                                        |
| `retryIf` / `abortIf` on `Error`                                                            | `retryIf` / `retryOn` on the typed errors of the chain                                                                                                                                           |
| `onRetryExhausted`                                                                          | the `retry.exhausted` event                                                                                                                                                                      |
| `.withTimeout(ms, 'cooperative')`, `.withTimeout(ms, { strategy })`, cooperative by default | `.withTimeout(duration, { mode })`, aggressive by default                                                                                                                                        |
| `.withCircuitBreaker({ failureThreshold, halfOpenAfter })`                                  | `.withCircuitBreaker({ trip: { consecutive }, openFor })`                                                                                                                                        |
| `.withSamplingCircuitBreaker({ threshold, duration, halfOpenAfter })`                       | `.withCircuitBreaker({ trip: { rate, duration }, openFor })`                                                                                                                                     |
| circuit `onOpen` / `onClose` / `onHalfOpen`                                                 | `onStateChange({ from, to })`                                                                                                                                                                    |
| `.withBulkhead(limit, queue)`, `.withBulkhead(limit, { queue })`                            | `.withBulkhead({ concurrency, queue, maxWait })`                                                                                                                                                 |
| `.withRateLimit({ key, maxCalls, windowMs, queue })`                                        | `.withRateLimit({ limit, per, key, maxWait })`                                                                                                                                                   |
| `.withDistributedLock(...)`                                                                 | `.withLock({ provider, key, timeout, ttl })`                                                                                                                                                     |
| `.withCache({ key, ttl, adapter })`                                                         | `.withCache({ provider, key, ttl })`                                                                                                                                                             |
| `optional: true` on cache, rate limit and lock                                              | the cache always fails open. A failing rate limit store or lock provider fails the call with `UnexpectedError`                                                                                   |
| `configStore.configure({ cache, rateLimiter, lock })`                                       | pass the provider or store to each strategy, or share a strategy instance                                                                                                                        |
| `.withSpan(name, attributes)`                                                               | the `name` option of the policy, `execute(fn, { name, attributes })`                                                                                                                             |
| `.withChaosFault()`, `.withChaosLatency()`                                                  | `.withChaos({ rate, latency, throws, error, value })`                                                                                                                                            |
| `Tenace.chaos.enable()` / `.disable()`                                                      | `const restore = Tenace.chaos(options)`                                                                                                                                                          |
| `Tenace.hooks.onX(fn)`, `use(plugin)`                                                       | `Tenace.instrument(listener(event => ...))`                                                                                                                                                      |
| `Tenace.all(tasks).withConcurrency(n).withRetryPerTask(...)`                                | `Tenace.all(tasks, { concurrency: n, policy })`                                                                                                                                                  |
| `.stopOnError(false)`                                                                       | `.settle()`                                                                                                                                                                                      |
| `onTaskComplete`, `onTaskError`, `onProgress`                                               | removed                                                                                                                                                                                          |
| `Semaphore`                                                                                 | removed, use a `Bulkhead`                                                                                                                                                                        |
| `Tenace.waitFor(condition, { interval, timeout, message, before, signal })`                 | `waitFor(condition, { interval, timeout, signal, clock })`, also `Tenace.waitFor()`. It rejects with a `TimeoutError`, and `interval` accepts a backoff                                          |
| `Tenace.wrap(fn, policy)`, `policy.wrap(fn)`                                                | removed, use `Tenace.call(fn)` or a closure                                                                                                                                                      |
| cockatiel dependency                                                                        | removed                                                                                                                                                                                          |
