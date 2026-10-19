# @julr/tenace

Typed, composable resilience policies for TypeScript: timeout, retry, circuit breaker, bulkhead, fallback, rate limit, lock, dedupe, cache, batches and chaos testing.

- **Typed error channel.** Every policy knows which errors it can produce. `.withTimeout()` adds `TimeoutError`, `.withFallbackOn(['TimeoutError'])` removes it, and functions returning a `Result` add their own errors.
- **One composition operator.** `.with(x)` takes a strategy or another policy. Policies are immutable, stateful strategies (circuit breakers, bulkheads) are shared by identity.
- **Opt-in Result output.** `.execute()` resolves or rejects like any promise. `.settle()` resolves with a typed `Result`.
- **Zero runtime dependencies**, ESM only, runs on Node, Bun and Cloudflare Workers.
- **Observability without lock-in**: an around-advice instrumentation contract, `diagnostics_channel` publishing, and [`@julr/tenace-otel`](../tenace-otel) for OpenTelemetry.

> [!WARNING]
> Tenace is still in development and is not published yet.

## Install

```sh
pnpm add @julr/tenace
```

## Quick start

```ts
import { backoff, match, Tenace } from '@julr/tenace'

const policy = Tenace.policy({ name: 'users.get' })
  .withTimeout('1s') // per attempt
  .withRetry({ retries: 3, delay: backoff.exponential(), retryOn: ['TimeoutError'] })
  .withFallbackOn(['TimeoutError'], () => null)

// resolves with the value or rejects
const user = await policy.execute(({ signal }) => fetchUser(id, { signal }))

// or get a typed Result
const result = await policy.settle(({ signal }) => fetchUser(id, { signal }))
const view = match(result, {
  ok: user => render(user),
  UnexpectedError: error => renderError(error.cause),
})
```

The function receives a context with a `signal` (aborted by timeouts, the caller or a failed batch sibling) and the 1-based `attempt` number.

## Core concepts

### Order

Strategies apply in the order they are added: **the first one is the innermost**.

```ts
Tenace.policy().withTimeout('1s').withRetry({ retries: 3 }) // 1s per attempt
Tenace.policy().withRetry({ retries: 3 }).withTimeout('5s') // 5s in total
```

`policy.describe()` lists the strategies, outermost first.

### `execute()` and `settle()`

|                                                                | `execute(fn)`                     | `settle(fn)`                                         |
| -------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| Success                                                        | resolves with the value           | `{ ok: true, value }`                                |
| `fn` throws                                                    | rejects with the raw thrown value | `{ ok: false, error: UnexpectedError }` with `cause` |
| `fn` returns `err(e)`, or a strategy fails (`TimeoutError`...) | rejects with the error            | `{ ok: false, error }`                               |
| The caller aborts its signal                                   | rejects with `signal.reason`      | rejects with `signal.reason`                         |

With `execute()`, `policy.isError(error)` tells known errors apart from raw throws and narrows them:

```ts
try {
  await policy.execute(fn)
} catch (error) {
  if (policy.isError(error)) error // TimeoutError | OtherError | ...
}
```

### Typed errors

Errors extend `TenaceError` and declare a literal `_tag`. Functions returning a `Result` add their errors to the channel, thrown values are always `UnexpectedError`.

```ts
import { err, ok, type Result, Tenace, TenaceError } from '@julr/tenace'

class NotFound extends TenaceError {
  static readonly tag = 'NotFound' // optional, makes instanceof work across package copies
  readonly _tag = 'NotFound' as const
  readonly code = 'E_NOT_FOUND' as const
}

async function findUser(id: string): Promise<Result<User, NotFound>> {
  const user = await db.find(id)
  return user ? ok(user) : err(new NotFound(`user ${id}`))
}

const result = await Tenace.policy()
  .withTimeout('1s')
  .settle(() => findUser(id))
//    ^? Result<User, NotFound | UnexpectedError | TimeoutError>

if (!result.ok && result.error instanceof NotFound) {
  // ...
}
```

`match(result, handlers)` is exhaustive: one handler per `_tag` plus `ok`, or `_` for the rest. `_` is required when the error type has untagged members (strings, plain `Error`s, `unknown`). `ErrorOf<typeof policy>` gives the errors of a policy.

**What callbacks see.** `retryIf`, fallbacks and `mapError` are typed with the errors of the chain so far. A reusable policy accepts any function, so the errors of functions it does not know yet show up as an opaque `OtherError`. Callbacks can pass it along, but cannot narrow it: `error instanceof HttpError` narrows it to `never`, and `error._tag === 'HttpError'` is a type error. There are two ways to make those errors visible:

```ts
// declare them on the reusable policy
Tenace.policy<HttpError>().withRetry({
  retries: 2,
  retryIf: error => error._tag === 'HttpError' && error.status >= 500,
})

// or bind the function: callbacks see its exact errors
await Tenace.call(() => findUser(id))
  .withFallbackOn(['NotFound'], () => null)
  .execute()
```

### Composition

`.with(x)` adds a strategy or inlines another policy, including its errors and fallback values. Policies are immutable: every method returns a new policy.

```ts
const breaker = new CircuitBreaker({ trip: { consecutive: 5 }, openFor: '30s' })
const paymentsApi = Tenace.policy().withTimeout('2s').with(breaker) // shared building block

const charge = Tenace.policy()
  .with(paymentsApi)
  .withFallbackOn(['CircuitOpenError'], () => 'queued')
const refund = Tenace.policy().with(paymentsApi).withRetry({ retries: 2 }) // same circuit
```

## Strategies

| Method                                                                                      | Strategy class                     | Adds to the error channel                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `withTimeout(duration, { mode })`                                                           | `Timeout`                          | `TimeoutError`                                 |
| `withRetry(options)`                                                                        | `Retry`                            |                                                |
| `withCircuitBreaker(breaker \| options)`                                                    | `CircuitBreaker`                   | `CircuitOpenError`                             |
| `withBulkhead(bulkhead \| options)`                                                         | `Bulkhead`                         | `BulkheadFullError`                            |
| `withRateLimit(limit \| options)`                                                           | `RateLimit`                        | `RateLimitError`                               |
| `withLock(lock \| options)`                                                                 | `Lock`                             | `LockNotAcquiredError`                         |
| `withFallback(handler)`, `withFallbackOn(tags, handler)`, `withFallbackWhen(when, handler)` |                                    | removes the handled errors, adds the handler's |
| `mapError(mapper)`                                                                          |                                    | replaces every error                           |
| `withDedupe(options)`, `withCache(options)`, `withStaleFallback(options)`                   | `Dedupe`, `Cache`, `StaleFallback` |                                                |
| `withChaos(options)`                                                                        | `Chaos`                            | its `error` type, if any                       |

Durations are milliseconds or strings: `'250ms'`, `'1.5s'`, `'2m'`, `'1h'`, `'1d'`. `Infinity` means never.

`withFallbackWhen(when, handler)` removes errors from the channel only when `when` is a type guard and the guarded errors have a literal `_tag`. A plain predicate, such as `error => error instanceof HttpError && error.status === 404`, handles the errors it matches and removes nothing.

### Timeout

Aggressive by default: at the deadline it returns `TimeoutError` and aborts the signal, even if the function ignores the signal. `{ mode: 'cooperative' }` aborts the signal and then waits for the function to settle.

### Retry

```ts
.withRetry({
  retries: 3, // at most 4 attempts
  delay: backoff.exponential({ base: '100ms', max: '10s' }), // default, with full jitter
  retryOn: ['TimeoutError'], // only these tags
  retryIf: (error, attempt) => true,
  maxDelay: '30s', // caps every delay, Retry-After included
  onRetry: ({ attempt, error, delayMs }) => {},
  budget: new RetryBudget({ ratio: 0.2 }), // shared cap against retry storms
})
```

- **`delay`** accepts a duration, `backoff.constant` / `linear` / `exponential`, or `(attempt, error) => duration`.
- **Retry-After:** errors with a `retryAfterMs` (rate limits, open circuits) are waited out at least that long, up to `maxDelay`.
- **Aborts:** retries stop as soon as the signal aborts.
- **Non-idempotent calls:** pass `execute(fn, { idempotent: false })` for calls that must not run twice. Only calls that were rejected before running (open circuit, full bulkhead, rate limit, lock) are then retried.

### Circuit breaker

```ts
const breaker = new CircuitBreaker({
  name: 'users-api',
  trip: { consecutive: 5 }, // or { rate: 0.5, calls: 20 }, or { rate: 0.5, duration: '30s' }
  openFor: '30s', // or a function of the opening count, e.g. a backoff preset
  halfOpen: { permits: 1, successes: 1, maxWait: '30s' },
  onStateChange: ({ from, to }) => {},
})
breaker.state // 'closed' | 'open' | 'half-open' | 'isolated'
const release = await breaker.isolate() // force open until release()
```

- **What counts as a failure:** errors do, except calls aborted by the caller and rejections from other policies (`CircuitOpenError`, `BulkheadFullError`, `RateLimitError`, `LockNotAcquiredError`). Override this with `classify(result)`.
- **Half-open:** while the trial calls run, other calls are rejected right away with a `retryAfterMs`.
- **Distributed state:** the state lives in a `CircuitBreakerStore`. The default store is in memory; write your own with the exported state machine, `circuitBreakerMachine`.

### Bulkhead

`new Bulkhead({ concurrency: 10, queue: 100, maxWait: '1s' })` limits concurrent calls. With the default `queue: 0`, it rejects as soon as every slot is busy.

### Rate limit, lock, dedupe, cache

These use the execution key when they don't set their own: `execute(fn, { key: 'user:1' })`. Lock, dedupe, cache and stale fallback need one of the two; the rate limit falls back to `'default'`.

```ts
Tenace.policy().withRateLimit({ limit: 10, per: '1s', maxWait: '500ms' }) // token bucket in memory
Tenace.policy().withLock({ key: 'reports', timeout: '5s' }) // in-process lock by default
Tenace.policy().withDedupe({ key: 'users.list' }) // concurrent calls share one run
Tenace.policy().withCache({ provider, ttl: '1m' }) // successes only, fail-open
Tenace.policy().withStaleFallback({ key: 'users.list', maxAge: '1h' }) // last success when the call fails
```

Distributed backends plug in through small interfaces. Structural adapters are included, with no runtime import:

```ts
import { rateLimiterFlexible } from '@julr/tenace/adapters/rate-limiter-flexible'
import { verrou } from '@julr/tenace/adapters/verrou'
import { bentocache } from '@julr/tenace/adapters/bentocache'

Tenace.policy()
  .withRateLimit({ store: rateLimiterFlexible(new RateLimiterRedis({ ... })) })
  .withLock({ provider: verrou(verrouInstance), key: 'reports' })
  .withCache({ provider: bentocache(bento), ttl: '1m' })
```

## Batches

```ts
const [user, posts] = await Tenace.all([() => getUser(id), () => getPosts(id)], {
  policy,
}).execute()

const users = await Tenace.map(ids, id => getUser(id), { policy, concurrency: 5 }).execute()
const results = await Tenace.map(ids, id => getUser(id), { policy }).settle() // one Result per id
```

- **`execute()`** is fail-fast: the first failure rejects, aborts the running tasks and skips the others.
- **`settle()`** runs every task.

## Custom strategies

```ts
class Audit extends Strategy<AuditError> {
  readonly name = 'audit'

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    const result = await next(context)
    if (!result.ok) context.emit({ type: 'custom', name: 'audit.failed' })
    return result
  }
}

Tenace.policy().with(new Audit()) // AuditError joins the error channel
```

Strategies resolve to Results and must not throw: a throw is treated as a bug and rejects the execution. The same rule applies to user callbacks (`retryIf`, fallback handlers, `mapError`): to fail on purpose, return `err(...)`.

## Your own Result type

To unwrap a Result library you already use, register it once:

```ts
declare module '@julr/tenace' {
  interface ResultTypes<R> {
    app: R extends AppOk<infer T> ? [T, never] : R extends AppErr<infer E> ? [never, E] : never
  }
}

registerResult('app', value =>
  value instanceof AppOk
    ? ok(value.data)
    : value instanceof AppErr
      ? err(value.failure)
      : undefined,
)
```

## Observability

```ts
import { listener, Tenace } from '@julr/tenace'
import { openTelemetry } from '@julr/tenace-otel'

Tenace.instrument(openTelemetry({ tracer, meter })) // global default
Tenace.policy({ name: 'users.get', instrumentation: listener(event => logger.info(event)) }) // per policy, added to the global one
```

- **Contract:** an `Instrumentation` wraps each execution and each attempt, so spans created by your code nest under the attempt span. It also receives events (`retry.scheduled`, `timeout`, `circuit.state_changed`, `bulkhead.rejected`, `fallback.used`...).
- **Isolation:** instrumentation bugs never change the outcome of an execution. Errors thrown by hooks and listeners are reported with `globalThis.reportError`, or as an uncaught exception where it is missing (Node).
- **diagnostics_channel:** executions are published on `tracing:tenace:execution`, `tracing:tenace:attempt` and `tenace:event` when something subscribes.
- **Cost:** executions nobody observes skip every hook.

## Testing

```ts
import { TestClock } from '@julr/tenace/testing'

const clock = new TestClock()
const done = policy.execute(fn, { clock })
await clock.advance('30s') // timeouts, retries, rate limits move with it

const restore = Tenace.chaos({ rate: 0.5, latency: '200ms' }) // faults around every call
```

## Runtimes

Node.js ≥ 22.18, Bun, and Cloudflare Workers (with or without `nodejs_compat`). There are no static `node:` imports.

## License

MIT
