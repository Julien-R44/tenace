---
title: Chaos
description: Inject latency, errors, throws, or values, to test how the rest of the policy and the application react.
---

Chaos injects faults into the steps added before it: latency, thrown errors, typed errors, or values. Use it in tests and game days to check what the rest of the policy and the application do when a dependency misbehaves.

```ts
import { Tenace } from '@julr/tenace'

// one call in five takes 2s longer, so the timeout fires
const policy = Tenace.policy().withChaos({ rate: 0.2, latency: '2s' }).withTimeout('1s')
```

## API

```ts nocheck
policy.withChaos(chaos?: Chaos | ChaosOptions)
new Chaos(options?: ChaosOptions)
Tenace.chaos(options): () => void
```

| Option    | Type                         | Default       | Description                                                      |
| --------- | ---------------------------- | ------------- | ---------------------------------------------------------------- |
| `rate`    | `number`                     | `1`           | Share of calls affected, from 0 to 1.                            |
| `latency` | `Duration \| () => Duration` |               | Delay added before the call.                                     |
| `throws`  | `() => unknown`              |               | Simulates a throw of the function. Becomes an `UnexpectedError`. |
| `error`   | `() => E`                    |               | Returns this error instead of calling the function.              |
| `value`   | `() => V`                    |               | Returns this value instead of calling the function.              |
| `enabled` | `boolean \| () => boolean`   | `true`        | Turns the chaos on and off without rebuilding the policy.        |
| `random`  | `() => number`               | `Math.random` | Source of randomness, for tests.                                 |

A `rate` outside 0 to 1 throws a `RangeError` when the policy is built.

## Behavior

For each call, chaos checks `enabled`, then draws a random number. The call is affected when the number is below `rate`. An affected call goes through these steps in order:

1. With `latency`, it waits. An abort during the wait ends the call.
2. With `error`, it returns `Result.err(error())`.
3. Otherwise, with `value`, it returns `Result.ok(value())`.
4. Otherwise, with `throws`, it fails as if the function threw `throws()`.
5. Otherwise, without `latency`, it fails as if the function threw a `ChaosError`.
6. Otherwise, it calls the function after the latency.

So `{}` makes every call throw a `ChaosError`, and `{ latency: '200ms' }` delays every call without failing it.

An `error`, `value`, or `throws` factory that throws fails the call as if the function threw that value: an `UnexpectedError`.

## Error channel

An `error` factory adds its error type to the channel, and a `value` factory adds its value type to the result. Thrown faults, including the default `ChaosError`, are `UnexpectedError` like any throw, so they do not change the types.

```ts
import { Tenace, TenaceError } from '@julr/tenace'

class Overloaded extends TenaceError {
  readonly _tag = 'Overloaded' as const
  readonly code = 'E_OVERLOADED' as const
}

const policy = Tenace.policy()
  .withChaos({ rate: 0.1, error: () => new Overloaded('chaos') })
  .withFallbackOn(['Overloaded'], () => null)
```

## Chaos around every call

`Tenace.chaos(options)` injects faults around the function of every policy, at every attempt, until you call the function it returns. It takes every option except `error` and `value`, so the types of your policies stay accurate.

```ts
import { Tenace } from '@julr/tenace'

const restore = Tenace.chaos({ rate: 0.5, latency: '200ms' })
// ... run the scenario
restore()
```

See [Testing](/guides/testing/) for how to use it in a test suite.
