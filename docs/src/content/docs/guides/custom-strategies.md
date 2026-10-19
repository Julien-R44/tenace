---
title: Write a custom strategy
description: Extend Strategy, declare what it adds to the error channel, and return Results.
---

A strategy is a class that extends `Strategy`. Its `execute()` method receives the execution context and the next step, and returns a `Result`. This guide builds a quota strategy that allows a fixed number of calls, then fails with its own error.

## Declare the errors

The type parameters of `Strategy` describe what the strategy does to the types of the policy:

```ts nocheck
abstract class Strategy<Adds = never, Removes = never, Value = never>
```

- `Adds`: the errors the strategy can produce. They join the error channel.
- `Removes`: the errors the strategy handles. They leave the channel.
- `Value`: the values the strategy can return instead of the function value, like a fallback.

## Implement execute()

```ts
import {
  type AnyResult,
  err,
  type ExecutionContext,
  type Next,
  Strategy,
  Tenace,
  TenaceError,
} from '@julr/tenace'

class QuotaExceeded extends TenaceError {
  readonly _tag = 'QuotaExceeded' as const
  readonly code = 'E_QUOTA_EXCEEDED' as const
}

class Quota extends Strategy<QuotaExceeded> {
  readonly name = 'quota'
  readonly #max: number
  #used = 0

  constructor(max: number) {
    super()
    this.#max = max
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    if (this.#used >= this.#max) {
      context.emit({ type: 'custom', name: 'quota.exceeded', attributes: { max: this.#max } })
      return err(new QuotaExceeded(`quota of ${this.#max} calls exceeded`))
    }
    this.#used++
    return next(context)
  }
}

const policy = Tenace.policy()
  .with(new Quota(2))
  .withFallbackOn(['QuotaExceeded'], () => 'over quota') // QuotaExceeded is in the channel
```

`name` is required. It appears in `policy.describe()` and in the instrumentation.

`next(context)` runs the inner steps and always resolves to a `Result`. Call it zero times to reject the call without running it, once to run it, or several times to retry it.

## Follow the rules

- **Return failures, do not throw them.** `execute()` must resolve to a `Result`. A throw is a bug, and the execution rejects with the thrown value, from `settle()` too.
- **Derive the context, do not mutate it.** `ExecutionContext` is frozen. `context.with({ ... })` returns a new context with a different `signal`, `attempt`, `key`, `clock`, or `idempotent` flag, for the inner steps.
- **Respect the signal.** Stop waiting when `context.signal` aborts, and check `context.signal.aborted` before you start new work.
- **Use the execution clock.** Wait with `context.clock.setTimeout()` and read the time with `context.clock.now()`, so the strategy works with a [`TestClock`](/guides/testing/).
- **Report events.** `context.emit({ type: 'custom', name, attributes })` sends an event to the instrumentation of the execution. `context.observed` is `false` when nothing listens, so you can skip building an expensive event.

## Share state on purpose

A strategy instance is shared by every policy you add it to. The `Quota` above counts the calls of every policy that holds the same instance. Keep per-execution state in local variables of `execute()`, and per-instance state in fields.

## The ExecutionContext

| Member        | Description                                               |
| ------------- | --------------------------------------------------------- |
| `signal`      | The signal of the current step.                           |
| `attempt`     | The 1-based attempt number.                               |
| `clock`       | The clock of the execution.                               |
| `key`         | The key of the execution, or `undefined`.                 |
| `idempotent`  | `false` when the execution runs with `idempotent: false`. |
| `scope`       | The instrumentation hooks of the execution.               |
| `observed`    | Whether an instrumentation observes the execution.        |
| `emit(event)` | Reports an event to the instrumentation.                  |
| `with(patch)` | Returns a new context with the given fields replaced.     |
