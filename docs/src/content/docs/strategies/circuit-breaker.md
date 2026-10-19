---
title: Circuit breaker
description: Stop calling a failing dependency for a while, then let trial calls check whether it recovered.
---

A circuit breaker stops calling a dependency that keeps failing. After enough failures, the circuit opens and every call fails with `CircuitOpenError` without running. After a while, the breaker lets trial calls through. Their outcome closes the circuit or opens it again.

```ts
import { CircuitBreaker, Tenace } from '@julr/tenace'

const breaker = new CircuitBreaker({
  name: 'users-api',
  trip: { consecutive: 5 },
  openFor: '30s',
})

const policy = Tenace.policy().withTimeout('1s').with(breaker)
```

Create one breaker per dependency and add the same instance to every policy that calls it. See [Composition and shared instances](/concepts/composition/).

## API

```ts nocheck
policy.withCircuitBreaker(breaker?: CircuitBreaker | CircuitBreakerOptions)
new CircuitBreaker(options?: CircuitBreakerOptions)
```

| Option          | Type                                          | Default                               | Description                                                                                                           |
| --------------- | --------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `name`          | `string`                                      | `'circuitBreaker'`                    | Name in events and in `describe()`.                                                                                   |
| `trip`          | `TripOptions`                                 | `{ consecutive: 5 }`                  | When the circuit opens. See [Trip conditions](#trip-conditions).                                                      |
| `openFor`       | `Duration \| (openCount: number) => Duration` | `'30s'`                               | How long the circuit stays open before it admits trial calls. Must be finite: use `isolate()` to keep a circuit open. |
| `halfOpen`      | `{ permits?, successes?, maxWait? }`          | see [Half-open](#half-open)           | How trial calls run.                                                                                                  |
| `classify`      | `(result: AnyResult) => CallOutcome`          | see [Classification](#classification) | How a finished call counts.                                                                                           |
| `onStateChange` | `({ from, to }) => void`                      |                                       | Called after each state change.                                                                                       |
| `store`         | `CircuitBreakerStore`                         | `MemoryCircuitBreakerStore`           | Where the state lives. See [Stores](#stores).                                                                         |
| `clock`         | `Clock`                                       | system clock                          | Clock for open durations and windows. Not the execution clock.                                                        |

## States

| State       | Calls                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| `closed`    | Run. The breaker records their outcome.                                |
| `open`      | Fail with `CircuitOpenError` without running, until `openFor` elapses. |
| `half-open` | Up to `halfOpen.permits` trial calls run. Other calls fail right away. |
| `isolated`  | Fail with `CircuitOpenError` until every isolation is released.        |

`breaker.state` returns the current state. With an asynchronous store, `state` throws a `TypeError`: use `await breaker.getState()` instead. Once `openFor` has elapsed, the state reads `half-open` even before the next call.

## Trip conditions

| `trip`                           | The circuit opens when                                   |
| -------------------------------- | -------------------------------------------------------- |
| `{ consecutive: 5 }`             | 5 calls in a row failed.                                 |
| `{ rate: 0.5, calls: 20 }`       | At least 50% of the last 20 calls failed.                |
| `{ rate: 0.5, duration: '30s' }` | At least 50% of the calls of the last 30 seconds failed. |

A rate-based condition waits for `minimumCalls` calls in the window before it can open the circuit. The default is `calls` for a count window and `10` for a time window. A time window is split into `buckets` that expire one at a time, 10 by default. `rate` is a number greater than 0 and at most 1. A `minimumCalls` greater than `calls` throws a `RangeError`.

The window starts empty each time the circuit closes.

## Open duration

`openFor` is a duration, or a function of the number of openings in a row. The count resets when trial calls close the circuit. A backoff preset fits:

```ts
import { backoff, CircuitBreaker } from '@julr/tenace'

// 1s, 2s, 4s... up to 1 minute, without jitter
const breaker = new CircuitBreaker({
  openFor: backoff.exponential({ base: '1s', max: '1m', jitter: 'none' }),
})
```

## Half-open

When `openFor` elapses, the next calls are trial calls.

| Option      | Default             | Description                                                         |
| ----------- | ------------------- | ------------------------------------------------------------------- |
| `permits`   | `1`                 | Trial calls admitted at the same time. Other calls fail right away. |
| `successes` | `permits`           | Successful trial calls needed to close the circuit.                 |
| `maxWait`   | `openFor`, or `30s` | A trial call that takes longer counts as a failure.                 |

`maxWait` defaults to `openFor` when it is a fixed duration other than 0, and to 30 seconds when `openFor` is a function or 0. A `maxWait` of 0 throws a `RangeError`. A trial call still running after `maxWait` counts as a failure, and so does one that succeeds after `maxWait`.

A failed trial call opens the circuit again, with the open duration of the next opening. A call rejected while the trial calls run gets a `CircuitOpenError` with the state `half-open` and a `retryAfterMs`.

## Classification

By default, a successful call is a success and a failed call is a failure, with two exceptions that the breaker ignores:

- Calls whose signal was aborted, such as a caller abort or an outer timeout. These are always ignored, whatever `classify` returns.
- Rejections by other strategies: `CircuitOpenError`, `BulkheadFullError`, `RateLimitError`, and `LockNotAcquiredError`. The dependency did not run, so its health is unknown.

`classify` replaces the default. It receives the `Result` of the call and returns `'success'`, `'failure'`, or `'ignored'`:

```ts
import { CircuitBreaker } from '@julr/tenace'

// a 404 says nothing about the health of the service
const breaker = new CircuitBreaker({
  classify: result => {
    if (result.ok) return 'success'
    if (result.error instanceof HttpError && result.error.status === 404) return 'ignored'
    return 'failure'
  },
})
```

A result recorded after the circuit changed state, such as a slow call that finishes after the circuit opened, is ignored.

## Isolate the circuit

`breaker.isolate()` forces the circuit open, for maintenance or a manual kill switch. It resolves with a function that releases the isolation:

```ts
import { CircuitBreaker } from '@julr/tenace'

const breaker = new CircuitBreaker()

const release = await breaker.isolate()
// every call fails with CircuitOpenError, state 'isolated'
await release()
```

Isolations stack. The circuit leaves the `isolated` state when every isolation is released, and starts closed. Calling a release function twice releases once.

## Error channel

Adds `CircuitOpenError`, with these fields:

- `state`: `'open'`, `'half-open'`, or `'isolated'`.
- `retryAfterMs`: when a new call may be admitted, `undefined` while isolated. A [retry](/strategies/retry/#retry-after) waits at least this long.

## Stores

The state of a breaker lives in a `CircuitBreakerStore`. The default `MemoryCircuitBreakerStore` keeps it in the process, synchronously. A store can be asynchronous, which lets one circuit be shared between processes. No distributed store ships with Tenace.

```ts nocheck
interface CircuitBreakerStore {
  admit(now: number, config: BreakerConfig): MaybePromise<Admission>
  record(
    ticket: Ticket,
    outcome: CallOutcome,
    now: number,
    config: BreakerConfig,
  ): MaybePromise<void>
  isolate(config: BreakerConfig): MaybePromise<void>
  release(config: BreakerConfig): MaybePromise<void>
  state(now: number, config: BreakerConfig): MaybePromise<CircuitState>
}
```

Every operation receives the current time and the configuration. `admit` returns a ticket with a generation number. `record` must ignore a ticket from an older generation, so that late results from before a transition do not move the circuit.

To write a store, reuse the state machine of the memory store, exported as `circuitBreakerMachine`. A store keeps one `MachineState`, plain data safe to serialize as JSON. It starts from `initialState(config)`, replaces the state with the result of `admit`, `record`, `isolate`, and `release`, and answers `state()` with `currentState`. In a distributed store, each replacement must be atomic, with a transaction or a compare-and-set. The `MachineState`, `WindowState`, and `TimeBucket` types are exported too.

## Events

| Event                   | Fields                             | When                                                                 |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `circuit.rejected`      | `breaker`, `state`, `retryAfterMs` | A call is rejected without running.                                  |
| `circuit.state_changed` | `breaker`, `from`, `to`            | The state changed since the last observed execution of this breaker. |
