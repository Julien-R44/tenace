---
title: Migrate from v2 to v3
description: Upgrade @julr/tenace from v2.x to v3.0.0, including clocks, polling, timers, and tests.
---

This guide covers upgrading `@julr/tenace` from **v2.x to v3.0.0**. In v3, the `Clock` class replaces the `Clock` interface, `systemClock`, `TestClock`, and the standalone `waitFor` helper.

If you use policies without a custom clock, a test clock, or the old polling helper, their builder calls do not need to change. Existing duration strings such as `'1s'` and `'2 minutes'` still work.

## Replace systemClock and Clock implementations

Replace the `systemClock` export with the shared `clock` instance.

Before (v2):

```ts nocheck
import { systemClock } from '@julr/tenace'

const timestamp = systemClock.now() // number, epoch milliseconds
```

After (v3):

```ts
import { clock } from '@julr/tenace'

const timestamp = clock.now().epochMilliseconds
```

`Clock` is now a class, not an interface. Pass `new Clock()` wherever you need an independent clock:

```ts
import { Clock, Tenace } from '@julr/tenace'

const clock = new Clock()
const policy = Tenace.policy().withTimeout('5s')
await policy.execute(fn, { clock })
```

The clock options of `execute()`, `settle()`, batches, `CircuitBreaker`, `RateLimit`, `RetryBudget`, and `Lock` now require a `Clock` instance. Objects implementing the old three-method interface are no longer accepted. There is no public constructor parameter for injecting an arbitrary time source. For controlled test time, use an instance's `fake()` method instead.

The `TimerHandle` export is removed. Replace stored handles and callback timers as described in [Replace callback timers](#replace-callback-timers).

## Separate timestamps from elapsed time

Choose the replacement for each `now()` call based on what it measures.

For a timestamp stored in a database or sent over an API, use `clock.now().epochMilliseconds`. For elapsed time, use `clock.monotonic()`.

Before (v2):

```ts nocheck
import { systemClock } from '@julr/tenace'

const startedAt = systemClock.now()
await fetchUser('user-1')
const elapsedMs = systemClock.now() - startedAt
```

After (v3):

```ts
import { clock } from '@julr/tenace'

const startedAt = clock.monotonic()
await fetchUser('user-1')
const elapsedMs = clock.monotonic() - startedAt
```

`clock.now()` returns a `Temporal.Instant`. Use its methods for calendar arithmetic or serialization:

```ts
import { clock } from '@julr/tenace'

const expiresAt = clock.now().add({ minutes: 30 })
const expiresAtIso = expiresAt.toString()
const expiresAtDate = new Date(expiresAt.epochMilliseconds)
```

Do not persist a monotonic reading as a timestamp. Its origin is unspecified. Compare readings from the same clock, without restoring or replacing its fake between them.

## Move waitFor calls onto a clock

Replace both the standalone `waitFor()` and `Tenace.waitFor()` with `clock.waitFor()`. Keep `timeout`, `interval`, `signal`, and the `{ signal, attempt }` callback context.

Before (v2):

```ts nocheck
import { waitFor } from '@julr/tenace'

await waitFor(async ({ signal }) => (await fetch(healthUrl, { signal })).ok, {
  timeout: '30s',
  interval: '500ms',
})
```

After (v3):

```ts
import { clock, Result } from '@julr/tenace'

declare const healthUrl: string

Result.unwrap(
  await clock.waitFor(async ({ signal }) => (await fetch(healthUrl, { signal })).ok, {
    timeout: '30s',
    interval: '500ms',
  }),
)
```

The method now returns a `Result` instead of rejecting. **Do not ignore the Result:** `await clock.waitFor(...)` alone continues after a timeout or cancellation. Use `Result.unwrap()` to propagate a failure by throwing, or check the Result before continuing:

```ts
import { clock } from '@julr/tenace'

declare const deployment: { isHealthy(): Promise<boolean> }

const ready = await clock.waitFor(() => deployment.isHealthy())
if (!ready.ok) {
  console.error(ready.error._tag, ready.error.cause)
} else {
  console.log('deployment is ready')
}
```

Update error handling as well:

- A polling timeout returns `TimeoutError` with `timeoutMs`.
- External cancellation returns `CancelledError`, not the caller's raw reason. Read that reason from `error.cause`.
- A callback exception, a rejected promise, or invalid options return `UnexpectedError`. Read the original failure from `error.cause`. Unwrapping throws the wrapper, not its cause.
- A callback returning `Result.err(error)` stops immediately and preserves the business error and its inferred type. `Result.ok(false)` keeps waiting; `Result.ok(true)` succeeds with `Result.ok()`.

The default timeout remains 10 seconds and the default interval remains 100ms. To replace the old `{ clock: customClock }` option, call `customClock.waitFor(...)` instead. For an observed value rather than a boolean condition, use [`clock.poll()`](/guides/wait-for/#retrieve-a-completed-job).

This Result contract applies to `waitFor()` and `poll()`. It does not change the cancellation behavior of `policy.settle()`.

## Replace TestClock in tests

Keep an isolated clock for concurrent tests. Create a `Clock`, then hold its fake-time controller separately. Pass the `Clock` to your policy, not the controller.

Before (v2):

```ts nocheck
import { Tenace } from '@julr/tenace'
import { TestClock } from '@julr/tenace/testing'

const clock = new TestClock(0)
const policy = Tenace.policy().withTimeout('1s')
const done = policy.settle(() => new Promise<never>(() => {}), { clock })
await clock.advance('1s')
const result = await done
```

After (v3):

```ts
import { Clock, Result, Tenace } from '@julr/tenace'

const clock = new Clock()
using time = clock.fake(new Date(0))
const policy = Tenace.policy().withTimeout('1s')
const done = policy.settle(() => new Promise<never>(() => {}), { clock })
await time.advanceBy('1s')
const result = await done
console.log(Result.unwrapErr(result, 'TimeoutError').timeoutMs) // 1000
```

`new TestClock()` started at epoch zero. `clock.fake()` starts at the current date. Pass `new Date(0)` to preserve deterministic epoch assertions, or `new Date(startAt)` to migrate a numeric starting timestamp. A `Temporal.Instant` is also accepted; a bare number is not.

Read time from `clock.now()` or `clock.monotonic()`. Advance time and inspect timers on `time`. `advance()` becomes `advanceBy()`; `runAll()` and `pendingTimers` remain available on the controller. `@julr/tenace/testing` exports `FakeClock`, not `TestClock`; obtain it through `clock.fake()` rather than constructing it directly.

For application code that imports the shared clock, you can fake that instance instead:

```ts
import { clock } from '@julr/tenace'

using time = clock.fake(new Date(0))
const waiting = clock.wait('1s')
await time.advanceBy('1s')
await waiting
```

The shared fake affects every consumer of that instance, including default circuit breakers. Do not use it in concurrent tests that need different times. A circuit breaker with an isolated clock must receive that clock in its own constructor; an execution's `{ clock }` option does not replace a shared breaker's clock. See [isolated clocks](/guides/testing/#give-a-test-its-own-clock).

Finish or cancel work before leaving the fake's scope. Restoration discards pending timers without resolving waits or aborting deadlines. Restore the active fake before creating another. Await each manual advancement, and do not call `advanceBy()` or `runAll()` after enabling `letTimePass()`. Automatic time advances pending waits, not real I/O or a lone deadline.

For `using`, include `ESNext.Disposable` alongside your existing TypeScript libraries. Without `using`, restore in `finally`:

```ts
import { Clock } from '@julr/tenace'

const clock = new Clock()
const time = clock.fake(new Date(0))
try {
  const waiting = clock.wait('1s')
  await time.advanceBy('1s')
  await waiting
} finally {
  clock.restore()
}
```

## Replace callback timers

Replace a promise built from `setTimeout` with `clock.wait()`.

Before (v2):

```ts nocheck
import { systemClock } from '@julr/tenace'

await new Promise<void>(resolve => systemClock.setTimeout(resolve, 500))
```

After (v3):

```ts
import { clock } from '@julr/tenace'

await clock.wait('500ms')
```

To cancel a wait, pass `{ signal }` as the second argument. Unlike polling, `clock.wait()` rejects with an `AbortError` when cancelled; it does not return a Result.

For a cancellable operation with a deadline, replace the abort controller and timer cleanup with `clock.timeout()`.

Before (v2):

```ts nocheck
import { systemClock } from '@julr/tenace'

const controller = new AbortController()
const timer = systemClock.setTimeout(
  () => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')),
  5000,
)
try {
  await fetch(url, { signal: controller.signal })
} finally {
  systemClock.clearTimeout(timer)
}
```

After (v3):

```ts
import { clock } from '@julr/tenace'

declare const url: string

using deadline = clock.timeout('5s')
await fetch(url, { signal: deadline.signal })
```

The deadline's abort reason is a `DOMException` named `TimeoutError`, not the Tenace error class returned by polling. Without `using`, call `deadline[Symbol.dispose]()` in `finally`. Use the exported `Deadline` type if you need to store it.

In custom strategies, use `context.clock.wait()` and `context.clock.timeout()` so waits follow the execution's clock. Replace duration calculations based on `context.clock.now()` with `context.clock.monotonic()`.

## Keep the Temporal fallback available

Tenace now depends on `temporal-polyfill`. Keep that dependency in your installation or bundle. Tenace uses native Temporal when available and dynamically imports the fallback otherwise.

Node 24 applications, including AdonisJS, need no flag or application-level polyfill setup. The fallback does not set `globalThis.Temporal`, so do not read the global to access a value returned by `clock.now()`. Use the Instant's own methods instead. See [runtime support](/reference/runtimes/).
