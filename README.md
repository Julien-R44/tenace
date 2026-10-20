![Tenace: resilience you can type-check](https://tenace.julr.dev/banner.png)

Resilience policies for TypeScript that know every error they can return.

Timeout, retry, circuit breaker, bulkhead, rate limit, lock, dedupe, cache, fallback, batches and chaos testing, composed into one policy. Each strategy adds its error to the type of the policy, and each fallback removes the errors it handles, so the compiler tells you what is left to handle.

```ts
import { Result, Tenace } from '@julr/tenace'

const policy = Tenace.policy({ name: 'users.get' })
  .withTimeout('1s')
  .withRetry({ retries: 3, retryOn: ['TimeoutError'] })
  .withCircuitBreaker({ trip: { consecutive: 5 }, openFor: '30s' })

const result = await policy.settle(({ signal }) => fetchUser(id, { signal }))

const message = Result.match(result, {
  ok: user => `Hello ${user.name}`,
  TimeoutError: () => 'The users API is slow, try again',
  CircuitOpenError: error => `The users API is down, retry in ${error.retryAfterMs}ms`,
  UnexpectedError: error => `Something broke: ${String(error.cause)}`,
})
```

Remove `withCircuitBreaker()` and the `CircuitOpenError` handler becomes a type error. Add a bulkhead and the build fails until you handle `BulkheadFullError`.

**[Documentation](https://tenace.julr.dev)**

## Install

```sh
npm install @julr/tenace
```

Tenace is ESM only and has no runtime dependencies. It runs on Node.js 22.18 or later, Bun, and Cloudflare Workers.

## Why Tenace

- **Typed errors.** Strategies add their errors to the type of the policy, fallbacks remove them, and your functions add their own by returning `Result.err(...)`. `Result.match()` needs one handler per error.
- **Promise or Result.** `execute()` resolves or rejects like any promise. `settle()` resolves with a typed `Result` instead.
- **A small Result type, for your code too.** Tenace passes Results through every layer, and you can return them from your own services without a policy: `Result.ok()`, `Result.err()`, `Result.match()`, and `Result.try()`. See [Result pattern](https://tenace.julr.dev/concepts/result-pattern/).
- **Composable.** `.with()` adds a strategy or inlines another policy. Policies are immutable, and a circuit breaker or bulkhead used by several policies is shared between them. Write your own strategy by extending `Strategy`.
- **Safe defaults.** Timeouts abort the `signal` your function receives. Retries back off with jitter, honor `Retry-After`, can share a budget against retry storms, and skip calls that must not run twice.
- **Testable.** `TestClock` drives timeouts, retry delays and open circuits without waiting. Chaos injects latency and faults into one policy, or into all of them.
- **Observable without lock-in.** One instrumentation interface sees every execution, attempt and event. Plug in your logger, `node:diagnostics_channel`, or OpenTelemetry with [`@julr/tenace-otel`](https://www.npmjs.com/package/@julr/tenace-otel).
- **Small.** One module per source file, so bundlers keep only what you import.

## Usage

### Order

The first strategy added is the innermost:

```ts
import { Tenace } from '@julr/tenace'

const perAttempt = Tenace.policy().withTimeout('1s').withRetry({ retries: 3 }) // 1s per attempt
const inTotal = Tenace.policy().withRetry({ retries: 3 }).withTimeout('5s') // 5s for all of them
```

### execute() or settle()

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s')

// the value, or a rejection
const user = await policy.execute(({ signal }) => fetchUser(id, { signal }))

// { ok: true, value } or { ok: false, error }
const result = await policy.settle(({ signal }) => fetchUser(id, { signal }))
if (!result.ok) logger.info(result.error._tag) // 'TimeoutError' | 'UnexpectedError'
```

With `settle()`, a thrown value becomes an `UnexpectedError` whose `cause` is the value. `execute()` rejects with the thrown value itself.

### Your own errors

Return `Result.err(...)` instead of throwing, and the error joins the type of the policy:

```ts
import { Result, Tenace, TenaceError } from '@julr/tenace'

class NotFound extends TenaceError {
  readonly _tag = 'NotFound' as const
  readonly code = 'E_NOT_FOUND' as const
}

declare const db: { find(id: string): Promise<User | undefined> }

async function findUser(id: string): Promise<Result<User, NotFound>> {
  const user = await db.find(id)
  return user ? Result.ok(user) : Result.err(new NotFound(`No user ${id}`))
}

const user = await Tenace.call(() => findUser(id))
  .withTimeout('1s')
  .withFallbackOn(['NotFound'], () => null)
  .execute()
// User | null. The policy can still fail with a TimeoutError or an UnexpectedError.
```

### Share a circuit between policies

```ts
import { CircuitBreaker, Tenace } from '@julr/tenace'

const paymentsBreaker = new CircuitBreaker({ name: 'payments', trip: { rate: 0.5, calls: 20 } })
const paymentsApi = Tenace.policy().withTimeout('2s').with(paymentsBreaker)

const charge = Tenace.policy()
  .with(paymentsApi)
  .withFallbackOn(['CircuitOpenError'], () => 'queued' as const)
const refund = Tenace.policy().with(paymentsApi).withRetry({ retries: 2 })
```

Both policies open and close the same circuit.

### Retry a value

`fetch` resolves with a `503` response instead of throwing. `retryIfValue` retries it like an error:

```ts
import { Tenace } from '@julr/tenace'

declare const url: string

const response = await Tenace.call(({ signal }) => fetch(url, { signal }))
  .withRetry({ retries: 3, retryIfValue: response => response.status >= 500 })
  .execute()
```

### Batches

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s').withRetry({ retries: 2 })

const [user, posts] = await Tenace.all([() => getUser(id), () => getPosts(id)], {
  policy,
}).execute()

const results = await Tenace.map(ids, userId => getUser(userId), {
  policy,
  concurrency: 5,
}).settle() // one Result per id
```

`execute()` stops at the first failure and aborts the other tasks. `settle()` runs them all.

### Wait for a condition

```ts
import { waitFor } from '@julr/tenace'

declare const healthUrl: string

await waitFor(async ({ signal }) => (await fetch(healthUrl, { signal })).ok, {
  interval: '500ms',
  timeout: '30s',
})
```

### Test without waiting

```ts
import { Tenace } from '@julr/tenace'
import { TestClock } from '@julr/tenace/testing'

const clock = new TestClock()
const policy = Tenace.policy().withTimeout('1s').withRetry({ retries: 2, delay: '10s' })

const done = policy.settle(() => new Promise<string>(() => {}), { clock })
await clock.runAll() // 3 timeouts and 2 delays, without waiting 23 seconds
const result = await done // a TimeoutError
```

### Observe

```ts
import { listener, Tenace } from '@julr/tenace'
import { openTelemetry } from '@julr/tenace-otel'

Tenace.instrument(openTelemetry()) // spans and metrics for every policy

const policy = Tenace.policy({
  name: 'users.get',
  instrumentation: listener(event => logger.info(event)), // retries, timeouts, state changes...
})
```

Executions that nothing observes skip every hook.

## Strategies

| Method                                                                   | Error it adds                 | Docs                                                                   |
| ------------------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------- |
| `withTimeout()`                                                          | `TimeoutError`                | [Timeout](https://tenace.julr.dev/strategies/timeout/)                 |
| `withRetry()`                                                            |                               | [Retry](https://tenace.julr.dev/strategies/retry/)                     |
| `withCircuitBreaker()`                                                   | `CircuitOpenError`            | [Circuit breaker](https://tenace.julr.dev/strategies/circuit-breaker/) |
| `withBulkhead()`                                                         | `BulkheadFullError`           | [Bulkhead](https://tenace.julr.dev/strategies/bulkhead/)               |
| `withRateLimit()`                                                        | `RateLimitError`              | [Rate limit](https://tenace.julr.dev/strategies/rate-limit/)           |
| `withLock()`                                                             | `LockNotAcquiredError`        | [Lock](https://tenace.julr.dev/strategies/lock/)                       |
| `withDedupe()`                                                           |                               | [Dedupe](https://tenace.julr.dev/strategies/dedupe/)                   |
| `withCache()`                                                            |                               | [Cache](https://tenace.julr.dev/strategies/cache/)                     |
| `withStaleFallback()`                                                    |                               | [Stale fallback](https://tenace.julr.dev/strategies/stale-fallback/)   |
| `withFallback()`, `withFallbackOn()`, `withFallbackWhen()`, `mapError()` | removes the errors it handles | [Fallback](https://tenace.julr.dev/strategies/fallback/)               |
| `withChaos()`                                                            | the error it injects          | [Chaos](https://tenace.julr.dev/strategies/chaos/)                     |

Rate limits and locks run in memory by default, and a cache takes a provider. To share them between instances with Redis, Postgres or DynamoDB, adapters for [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible), [Verrou](https://verrou.dev) and [BentoCache](https://bentocache.dev) are included: see [Running on multiple instances](https://tenace.julr.dev/distributed/overview/).

## Packages

| Package                                       | Description                                         |
| --------------------------------------------- | --------------------------------------------------- |
| [`@julr/tenace`](./packages/tenace)           | The policies, strategies, batches and test helpers. |
| [`@julr/tenace-otel`](./packages/tenace-otel) | OpenTelemetry traces and metrics.                   |

## Contributing

```sh
pnpm install
pnpm checks   # format, lint, typecheck with TS 7 and TS 5.9, tests
pnpm build
pnpm docs:dev # documentation on http://localhost:4321
```

The documentation is an [Astro Starlight](https://starlight.astro.build) site in [`docs/`](./docs). `pnpm typecheck` also typechecks the TypeScript blocks of the documentation and of the READMEs against the sources. Mark a block that is not valid on its own with ` ```ts nocheck `.

### Releasing

Releases go through [Changesets](https://changesets.dev). Add a changeset to each pull request that changes a published package:

```sh
pnpm changeset   # pick the packages and the bump, then describe the change
```

On every push to `main`, the `release` workflow opens or updates a "version packages" pull request that bumps the versions and writes the changelogs. Merging it publishes the new versions to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers), then pushes the git tags and creates the GitHub releases. No npm token is involved.

## License

MIT
