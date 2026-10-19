---
title: Instrumentation
description: Observe every execution, attempt, and event through one around-advice contract.
---

An instrumentation observes executions. Tenace calls it around each execution and each attempt, and passes it the events the strategies report: retries, timeouts, rejections, fallbacks. The OpenTelemetry package, `listener()`, and the `diagnostics_channel` publisher all implement the same `Instrumentation` interface.

## Log events with listener()

`listener(onEvent)` builds an instrumentation that receives the events only:

```ts
import { listener, Tenace } from '@julr/tenace'

Tenace.instrument(listener((event, info) => logger.info({ operation: info.name, event })))
```

`info` describes the execution. See [Execution info](#execution-info).

## Set the instrumentation

`Tenace.instrument(...instrumentations)` sets the default instrumentation of every policy. With several arguments, it combines them. It returns a function that removes this setting. The default is the latest setting not removed yet, so restore functions can run in any order:

```ts
import { listener, Tenace } from '@julr/tenace'
import { openTelemetry } from '@julr/tenace-otel'

const restore = Tenace.instrument(
  openTelemetry(),
  listener(event => logger.debug(event)),
)
```

The `instrumentation` option of a policy adds an instrumentation for that policy. The default one still runs and wraps it: its `execution()` starts first and ends last. An instrumentation that is already part of the default one runs once, even when the policy combines it with others. Two separate `openTelemetry()` instances still record every execution twice. Set `instrumentation: false` to turn the default one off for a policy.

```ts
import { listener, Tenace } from '@julr/tenace'

const policy = Tenace.policy({
  name: 'users.get',
  instrumentation: listener(event => logger.info(event)),
})
```

The executions are also published on the [diagnostics channels](/observability/diagnostics-channel/).

The default lives on `globalThis`, so it applies to every copy of Tenace loaded in the process.

## Execution info

Every hook receives an `ExecutionInfo`:

| Field        | Description                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `name`       | The `name` option of `execute()`, then the `name` of the policy, then `'tenace'`. Keep it low cardinality. |
| `strategies` | The strategy names, from the outermost to the innermost.                                                   |
| `attributes` | The `attributes` option of `execute()`, `{}` by default. Values are strings, numbers, or booleans.         |

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy({ name: 'users.get' }).withTimeout('1s')

await policy.execute(() => getUser(id), {
  name: 'users.get_by_id',
  attributes: { 'user.tier': 'premium' },
})
```

## Write an instrumentation

The interface has one method:

```ts nocheck
interface Instrumentation {
  execution(
    info: ExecutionInfo,
    run: (scope: ExecutionScope) => Promise<AnyResult>,
  ): Promise<AnyResult>
}

interface ExecutionScope {
  attempt(info: AttemptInfo, run: () => Promise<AnyResult>): Promise<AnyResult>
  event(event: TenaceEvent): void
}
```

`execution()` wraps the whole execution. It calls `run(scope)` once, and returns what `run` resolves with: the final `Result` of the execution. `run` rejects only when a strategy or a callback throws, or with `signal.reason` when the caller aborts.

The `scope` you pass to `run` receives the rest:

- `attempt(info, run)` wraps each call of your function. `info.attempt` is the 1-based attempt number. Call `run()` inside the context your function should see, such as an active span.
- `event(event)` receives each event the strategies report. The [event reference](/reference/events/) lists them.

This instrumentation logs the duration and outcome of each execution, and makes the attempt number available to the code of your function through `AsyncLocalStorage`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import { type Instrumentation, Tenace } from '@julr/tenace'

export const currentAttempt = new AsyncLocalStorage<number>()

const timing: Instrumentation = {
  async execution(info, run) {
    const started = performance.now()
    const result = await run({
      attempt: (attempt, fn) => currentAttempt.run(attempt.attempt, fn),
      event: event => logger.debug({ operation: info.name, event: event.type }),
    })
    logger.info({ operation: info.name, ok: result.ok, ms: performance.now() - started })
    return result
  },
}

Tenace.instrument(timing)
```

`combine(...instrumentations)` merges several into one. The first wraps the others: its `execution()` starts first and ends last. An instrumentation given twice, directly or through another `combine()`, runs once. An `event` handler that throws does not keep the event from the others.

## When an instrumentation fails

A bug in an instrumentation never changes the outcome of an execution. Tenace enforces the contract:

- An error thrown by a hook or an event handler is reported with `globalThis.reportError`. Where it is missing, as on Node.js, the error is thrown from a microtask, so it becomes an uncaught exception, which stops the process by default.
- `run` and the `run` of `attempt` call your function at most once. A second call rejects with a `TypeError`, which is reported.
- The caller always gets the outcome of `run`, whatever the hook returns.
- An `execution()` or `attempt()` hook that settles without calling `run` is reported, and the execution runs without it.
- Events emitted after the execution settled are dropped, and attempts started after it skip the `attempt()` hook. This happens when a [dedupe](/strategies/dedupe/) run keeps going for other callers after its first caller aborts.

A hook that never settles still blocks the execution.

## What it costs

When no instrumentation is set and nothing subscribes to the [diagnostics channels](/observability/diagnostics-channel/), executions skip every hook. A strategy can check `context.observed` to skip building an event nobody receives.
