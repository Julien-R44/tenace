# Changelog

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
