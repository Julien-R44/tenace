---
title: API
description: The Tenace entry point, the Policy methods, execution options, and helper types.
---

## Entry points

| Import path                                   | Exports                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@julr/tenace`                                | `Tenace`, the strategies, the errors, `ok`, `err`, `match`, `backoff`, the instrumentation helpers, and the types. |
| `@julr/tenace/testing`                        | `TestClock`                                                                                                        |
| `@julr/tenace/adapters/rate-limiter-flexible` | `rateLimiterFlexible`                                                                                              |
| `@julr/tenace/adapters/verrou`                | `verrou`                                                                                                           |
| `@julr/tenace/adapters/bentocache`            | `bentocache`                                                                                                       |
| `@julr/tenace-otel`                           | `openTelemetry`, `errorType`                                                                                       |

## Tenace

| Method                                   | Returns         | Description                                                                               |
| ---------------------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `Tenace.policy<E>(options?)`             | `Policy`        | A reusable policy. `E` declares errors the functions may return, for the callbacks.       |
| `Tenace.call(fn, options?)`              | `Policy`        | A policy bound to `fn`. Throws a `TypeError` when `fn` is not a function.                 |
| `Tenace.all(tasks, options?)`            | `Batch`         | Runs `tasks` through a policy. See [Batches](/guides/batches/).                           |
| `Tenace.map(items, fn, options?)`        | `Batch`         | Runs `fn(item, context, index)` for each item through a policy.                           |
| `Tenace.instrument(...instrumentations)` | `() => void`    | Sets the default instrumentation. Returns a function that removes this setting.           |
| `Tenace.chaos(options)`                  | `() => void`    | Injects faults around every function call. Returns a function that removes this setting.  |
| `Tenace.waitFor(condition, options?)`    | `Promise<void>` | Calls `condition` until it returns `true`. See [Wait for a condition](/guides/wait-for/). |

The functions returned by `Tenace.instrument()` and `Tenace.chaos()` can be called in any order: the active setting is the latest one not removed yet.

### PolicyOptions

| Option            | Type                       | Default    | Description                                                          |
| ----------------- | -------------------------- | ---------- | -------------------------------------------------------------------- |
| `name`            | `string`                   | `'tenace'` | Operation name reported to instrumentation.                          |
| `instrumentation` | `Instrumentation \| false` | none       | Added to the default for this policy. `false` turns the default off. |

The default set with `Tenace.instrument()` wraps the `instrumentation` option. See [Instrumentation](/observability/instrumentation/#set-the-instrumentation).

## Policy

Every method that adds a strategy returns a new policy. See [Composition](/concepts/composition/).

| Method                                  | Strategy page                                   |
| --------------------------------------- | ----------------------------------------------- |
| `with(strategyOrPolicy)`                | [Composition](/concepts/composition/)           |
| `withTimeout(duration, options?)`       | [Timeout](/strategies/timeout/)                 |
| `withRetry(options)`                    | [Retry](/strategies/retry/)                     |
| `withCircuitBreaker(breakerOrOptions?)` | [Circuit breaker](/strategies/circuit-breaker/) |
| `withBulkhead(bulkheadOrOptions)`       | [Bulkhead](/strategies/bulkhead/)               |
| `withRateLimit(rateLimitOrOptions)`     | [Rate limit](/strategies/rate-limit/)           |
| `withLock(lockOrOptions?)`              | [Lock](/strategies/lock/)                       |
| `withDedupe(dedupeOrOptions?)`          | [Dedupe](/strategies/dedupe/)                   |
| `withCache(cacheOrOptions)`             | [Cache](/strategies/cache/)                     |
| `withStaleFallback(staleOrOptions?)`    | [Stale fallback](/strategies/stale-fallback/)   |
| `withChaos(chaosOrOptions?)`            | [Chaos](/strategies/chaos/)                     |
| `withFallback(handler)`                 | [Fallback](/strategies/fallback/)               |
| `withFallbackOn(tags, handler)`         | [Fallback](/strategies/fallback/)               |
| `withFallbackWhen(when, handler)`       | [Fallback](/strategies/fallback/)               |
| `mapError(mapper)`                      | [Fallback](/strategies/fallback/#maperror)      |

| Member                  | Description                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `execute(fn, options?)` | Runs `fn`. Resolves with its value or rejects. A bound policy takes only `options`.                               |
| `settle(fn, options?)`  | Runs `fn`. Resolves with a `Result`. A bound policy takes only `options`.                                         |
| `isError(error)`        | Whether `execute()` of this policy rejected with `error`, a known error. Narrows its type, `OtherError` included. |
| `describe()`            | The strategy names, from the outermost to the innermost.                                                          |
| `strategies`            | The strategy instances, from the innermost to the outermost.                                                      |

See [execute() and settle()](/concepts/execute-and-settle/).

### ExecuteOptions

| Option       | Type          | Default         | Description                                                                                                           |
| ------------ | ------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `signal`     | `AbortSignal` |                 | Aborting it stops the execution. The promise rejects with `signal.reason`, without running `fn` when already aborted. |
| `clock`      | `Clock`       | `systemClock`   | Clock of the time-based strategies of this execution. See [Testing](/guides/testing/).                                |
| `name`       | `string`      | the policy name | Operation name reported to instrumentation.                                                                           |
| `key`        | `string`      |                 | Key of the execution. See [Keys](/guides/keys-and-adapters/).                                                         |
| `idempotent` | `boolean`     | `true`          | `false` when running the function twice is not safe. See [Idempotency](/strategies/retry/#idempotency).               |
| `attributes` | `Attributes`  | `{}`            | Extra attributes reported to instrumentation. Keep them low cardinality.                                              |

### Context

The function receives a `Context`:

| Field     | Type          | Description                                                               |
| --------- | ------------- | ------------------------------------------------------------------------- |
| `signal`  | `AbortSignal` | Aborts when the caller aborts, a timeout fires, or a batch sibling fails. |
| `attempt` | `number`      | The 1-based attempt number.                                               |

## Results

| Export                                                    | Description                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ok(value?)`                                              | Builds `{ ok: true, value }`.                                                                                                   |
| `err(error)`                                              | Builds `{ ok: false, error }`.                                                                                                  |
| `isResult(value)`                                         | Whether `value` is a Result created by any copy of Tenace.                                                                      |
| `match(result, handlers)`                                 | Calls the `ok` handler or the handler named after the error `_tag`. See [Typed errors](/concepts/typed-errors/#match-a-result). |
| `registerResult(name, adapter)`, `unregisterResult(name)` | Register a foreign Result type. See [Use your own Result type](/guides/custom-result-types/).                                   |

## Types

| Type                             | Description                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Result<T, E>`                   | `Ok<T> \| Err<E>`.                                                                                     |
| `ErrorOf<P>`                     | The errors of `P` without `OtherError`. Type a predicate passed to callbacks with `CurrentError`.      |
| `CurrentError<P>`                | The errors the callbacks added at the end of `P` receive, `OtherError` included.                       |
| `KnownError<E>`                  | `E` without `UnexpectedError`, `OtherError` included: the errors `execute()` rejects with as they are. |
| `OtherError`                     | Stands for the errors a reusable policy did not declare.                                               |
| `ReusablePolicy<V>`              | Any reusable policy, for a parameter that runs functions.                                              |
| `AnyPolicy`                      | Any policy, bound or not. It cannot run a function.                                                    |
| `ValueOf<R>`, `ErrorOfResult<R>` | The value and error types of a Result type.                                                            |
| `TagOf<E>`, `ByTag<E, K>`        | The tags of an error union, and its members with tag `K`.                                              |
| `Duration`                       | A number of milliseconds, or a string: `'250ms'`, `'1.5s'`, `'2m'`, `'1h'`, `'1d'`.                    |

To type a parameter that receives a policy, see [Type a policy parameter](/concepts/reusable-and-bound-policies/#type-a-policy-parameter).

## Durations

Every duration option accepts a number of milliseconds or a string with one unit: `ms`, `s`, `m`, `h`, or `d`. The number of a string is a non-negative decimal, and `'+1s'`, `'5.s'`, and `'1e3ms'` are accepted too. `toMs(duration)` converts a duration to milliseconds. It throws a `RangeError` for a negative, `NaN`, or malformed duration. `Infinity` is accepted and means never.

## Clock

```ts nocheck
interface Clock {
  now(): number
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}
```

`setTimeout()` must accept delays longer than the timer limit of the platform, and never fire a timer of `Infinity`. `systemClock` uses `Date.now()` and the global timers, and chains timers for delays longer than about 24.8 days. `TestClock` from `@julr/tenace/testing` moves only when you tell it to.
