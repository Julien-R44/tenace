---
title: Wait for a condition
description: Wait for a boolean condition or poll for a value, with typed errors and cancellation.
---

Use `clock.waitFor()` to wait for a boolean condition, such as a service becoming healthy. Use `clock.poll()` to retrieve a value, such as a completed job.

Both methods return a `Result`, including on timeout, cancellation, or an exception. Check the Result before continuing. To propagate a failure by throwing, call `Result.unwrap()` explicitly.

## Wait for a service to start

```ts
import { clock, Result } from '@julr/tenace'

declare const healthUrl: string

const healthy = await clock.waitFor(async ({ signal }) => (await fetch(healthUrl, { signal })).ok, {
  timeout: '30s',
  interval: '500ms',
})

Result.unwrap(healthy)
// Continue startup only after the service is healthy.
```

The first check runs immediately. A false condition tries again after `interval`. The next check starts after the previous one finishes, so checks never overlap. Options are optional: the timeout defaults to 10 seconds and the interval to 100ms.

Pass the provided `signal` to `fetch` and other cancellable operations. The timeout covers the whole call, including a check that ignores its signal. Results that arrive after timeout or cancellation are ignored.

## Retrieve a completed job

Return the observation directly and put the acceptance condition in `until`. The predicate receives the unwrapped value, including when the observation returns a `Result`.

```ts
import { clock, Result } from '@julr/tenace'

declare const jobs: {
  find(id: string, options: { signal: AbortSignal }): Promise<{ done: boolean; output: string }>
}

const completed = await clock.poll(({ signal }) => jobs.find('job-1', { signal }), {
  until: job => job.done,
  timeout: '2m',
  interval: '500ms',
})

console.log(Result.unwrap(completed).output)
```

`until` is required and returns a boolean, synchronously or asynchronously. The timeout also bounds an asynchronous predicate. No observation is a sentinel. `0`, `false`, `null`, and `undefined` are valid values, so waiting for a queue to empty needs no special conversion:

```ts
import { clock, Result } from '@julr/tenace'

declare const queue: { pendingCount(): Promise<number> }

const empty = await clock.poll(() => queue.pendingCount(), { until: count => count === 0 })
console.log(Result.unwrap(empty)) // 0
```

## Preserve errors returned by your service

A `Result.err(error)` ends the operation immediately. Tenace preserves the business error and its inferred type, without wrapping it or nesting Results. `Result.ok(false)` keeps waiting; `Result.ok(true)` completes `waitFor()` with `Result.ok()`.

```ts
import { clock, type Context, Result, TenaceError } from '@julr/tenace'

class DeploymentGone extends TenaceError {
  readonly _tag = 'DeploymentGone' as const
  readonly code = 'E_DEPLOYMENT_GONE' as const
}

declare const deployment: {
  isHealthy(context: Context): Promise<Result<boolean, DeploymentGone>>
}

const healthy = await clock.waitFor(context => deployment.isHealthy(context))
// Result<void, DeploymentGone | TimeoutError | CancelledError | UnexpectedError>

Result.match(healthy, {
  ok: () => console.log('healthy'),
  DeploymentGone: error => console.error('deployment was deleted', error),
  TimeoutError: error => console.error('health check timed out', error.timeoutMs),
  CancelledError: error => console.error('startup was cancelled', error.cause),
  UnexpectedError: error => console.error('health check failed', error.cause),
})
```

Exceptions thrown by a callback, rejected promises, and invalid arguments produce `UnexpectedError` with the original cause. An elapsed polling timeout produces `TimeoutError`. External cancellation produces `CancelledError` with `signal.reason` in `cause`, even when the caller aborted with a timeout error.

An already aborted signal returns a failed Result without calling the observation. This contract belongs to `waitFor()` and `poll()`; it does not change cancellation of `policy.settle()`.

## Increase the interval between attempts

Use a backoff when a remote API should be checked less often over time. Both the callback context and the interval function receive an attempt number starting at 1.

```ts
import { backoff, clock, Result } from '@julr/tenace'

declare const db: { ping(): Promise<void> }

const connected = await clock.waitFor(
  () =>
    db.ping().then(
      () => true,
      () => false,
    ),
  {
    timeout: '1m',
    interval: backoff.exponential({ base: '100ms', max: '5s', jitter: 'none' }),
  },
)
Result.unwrap(connected)
```

Catch an error inside the callback only when that error means "not ready yet". Otherwise, return a business error or let Tenace capture the exception.

Intervals shorter than 1ms become 1ms. The last pause is cut to the deadline. `timeout: Infinity` disables expiration; cancellation still works. A zero timeout permits one immediate check but never a second one.

## Keep returned resources usable

`waitFor()` aborts its internal signal on every exit, success included. `poll()` leaves that signal live on success so you can read a returned `Response` body. Its deadline is still disposed, and an external caller signal remains linked to the resource.

```ts
import { clock, Result } from '@julr/tenace'

declare const url: string
declare const caller: AbortController

const response = await clock.poll(({ signal }) => fetch(url, { signal }), {
  until: response => response.ok,
  timeout: '30s',
  signal: caller.signal,
})

const body = await Result.unwrap(response).text()
```

The timeout bounds `poll()` itself, not the later body read. Detached tasks and later resource use are outside its Result guarantee. Dispose resources from observations you do not retain.

## Migrate the previous waitFor helper

Before:

```ts nocheck
import { waitFor } from '@julr/tenace'

await waitFor(() => isReady(), { timeout: '30s', interval: '500ms' })
```

After:

```ts
import { clock, Result } from '@julr/tenace'

declare function isReady(): Promise<boolean>

Result.unwrap(await clock.waitFor(() => isReady(), { timeout: '30s', interval: '500ms' }))
```

The standalone `waitFor` and `Tenace.waitFor` are removed. The new method returns a Result instead of rejecting. Keep the Result to handle failures explicitly, or unwrap it to preserve failure propagation. To use an isolated clock, call that instance's `waitFor()` rather than passing a `clock` option.

The pauses and the deadline follow the clock. A [fake clock](/guides/testing/) drives them in tests. See the [Clock reference](/reference/api/#clock) for option types.
