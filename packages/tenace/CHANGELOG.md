# Changelog

## 2.0.0-next.0

Tenace 2 is a rewrite. The library no longer wraps cockatiel and has no runtime dependencies. The API changed everywhere: see [Breaking changes](#breaking-changes) below.

### Highlights

- **Typed error channel.** A policy knows which errors it can produce. `.withTimeout()` adds `TimeoutError`, `.withFallbackOn(['TimeoutError'], ...)` removes it, and functions returning `err(...)` add their own errors. `ErrorOf<typeof policy>` gives the union.
- **`execute()` or `settle()`.** `execute()` resolves with the value or rejects. `settle()` resolves with a typed `Result`, and `match()` handles each error tag exhaustively.
- **One composition operator.** `.with(x)` adds a strategy or inlines another policy. Policies are immutable. Stateful strategies (circuit breakers, bulkheads, rate limits) are shared by identity between the policies that use them.
- **Custom strategies.** Extend `Strategy<Adds, Removes>` to write your own, with the same typing as the built-in ones.
- **Your own Result type.** Augment `ResultTypes` and call `registerResult()` to unwrap a Result library you already use.

### Strategies

- **Timeout**: aggressive (default) or cooperative. Durations accept milliseconds or strings such as `'1.5s'`.
- **Retry**:
  - `backoff.constant`, `linear`, `exponential` with full or equal jitter;
  - `retryOn` by tag, `retryIf`, and `retryIfValue` to retry successful values such as a `503` response;
  - honors `retryAfterMs` (rate limits, open circuits), capped by `maxDelay`;
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
- One module per source file, so a bundler only keeps what you import: `ok()` alone weighs about 130 bytes gzipped.

### Breaking changes

| 1.x                                                                         | 2.0                                                                                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.call(fn)`                                                           | `policy.execute(fn)` or `policy.settle(fn)`                                                                                                             |
| `.withRetry(3)`, `.withRetry({ times })`                                    | `.withRetry({ retries })`                                                                                                                               |
| `.withExponentialBackoff(...)`                                              | `.withRetry({ delay: backoff.exponential(...) })`                                                                                                       |
| `retryIf` / `abortIf` on `Error`                                            | `retryIf` / `retryOn` on the typed errors of the chain                                                                                                  |
| `onRetryExhausted`                                                          | the `retry.exhausted` event                                                                                                                             |
| `.withTimeout(ms, { strategy })`                                            | `.withTimeout(duration, { mode })`                                                                                                                      |
| `.withCircuitBreaker(5, 10000)`                                             | `.withCircuitBreaker({ trip: { consecutive: 5 }, openFor: '10s' })`                                                                                     |
| `.withSamplingCircuitBreaker(...)`                                          | `.withCircuitBreaker({ trip: { rate, duration } })`                                                                                                     |
| circuit `onOpen` / `onClose` / `onHalfOpen`                                 | `onStateChange({ from, to })`                                                                                                                           |
| `.withBulkhead(limit, { queue })`                                           | `.withBulkhead({ concurrency, queue, maxWait })`                                                                                                        |
| `.withRateLimit({ key, maxCalls, windowMs, queue })`                        | `.withRateLimit({ limit, per, key, maxWait })`                                                                                                          |
| `.withDistributedLock(...)`                                                 | `.withLock({ provider, key, timeout, ttl })`                                                                                                            |
| `.withCache({ key, ttl, adapter })`                                         | `.withCache({ provider, key, ttl })`                                                                                                                    |
| `optional: true` on cache, rate limit and lock                              | the cache always fails open. A failing rate limit store or lock provider fails the call with `UnexpectedError`                                          |
| `configStore.configure({ cache, rateLimiter, lock })`                       | pass the provider or store to each strategy, or share a strategy instance                                                                               |
| `.withSpan(name, attributes)`                                               | the `name` option of the policy, `execute(fn, { name, attributes })`                                                                                    |
| `.withChaosFault()`, `.withChaosLatency()`                                  | `.withChaos({ rate, latency, throws, error, value })`                                                                                                   |
| `Tenace.chaos.enable()` / `.disable()`                                      | `const restore = Tenace.chaos(options)`                                                                                                                 |
| `Tenace.hooks.onX(fn)`, `use(plugin)`                                       | `Tenace.instrument(listener(event => ...))`                                                                                                             |
| `Tenace.all(tasks).withConcurrency(n).withRetryPerTask(...)`                | `Tenace.all(tasks, { concurrency: n, policy })`                                                                                                         |
| `.stopOnError(false)`                                                       | `.settle()`                                                                                                                                             |
| `onTaskComplete`, `onTaskError`, `onProgress`                               | removed                                                                                                                                                 |
| `Semaphore`                                                                 | removed, use a `Bulkhead`                                                                                                                               |
| `Tenace.waitFor(condition, { interval, timeout, message, before, signal })` | `waitFor(condition, { interval, timeout, signal, clock })`, also `Tenace.waitFor()`. It rejects with a `TimeoutError`, and `interval` accepts a backoff |
| `Tenace.wrap(fn, policy)`, `policy.wrap(fn)`                                | removed, use `Tenace.call(fn)` or a closure                                                                                                             |
| cockatiel dependency                                                        | removed                                                                                                                                                 |
