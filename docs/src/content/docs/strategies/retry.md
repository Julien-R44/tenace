---
title: Retry
description: Run the steps added before again when they fail, with backoff, filters, a shared budget, and idempotency rules.
---

A retry runs the steps added before it again when they fail. It returns the first success, or the last error once it stops.

```ts
import { backoff, Tenace } from '@julr/tenace'

const policy = Tenace.policy()
  .withTimeout('1s')
  .withRetry({
    retries: 3,
    delay: backoff.exponential({ base: '100ms', max: '10s' }),
    retryOn: ['TimeoutError'],
  })
```

## API

```ts nocheck
policy.withRetry(options: RetryOptions)
new Retry(options: RetryOptions)
```

| Option              | Type                                       | Default                 | Description                                                                                            |
| ------------------- | ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `retries`           | `number`                                   | required                | Retries after the first attempt. `retries: 2` means at most 3 attempts.                                |
| `delay`             | `Duration \| (attempt, error) => Duration` | `backoff.exponential()` | Delay before each retry. See [Delays](#delays).                                                        |
| `retryOn`           | `readonly string[]`                        | every error             | Retry only the errors with these `_tag` values. `CircuitOpenError` is retried only when listed.        |
| `retryIf`           | `(error, attempt) => boolean`              | every error             | Retry only the errors for which it returns `true`.                                                     |
| `retryIfValue`      | `(value, attempt) => boolean`              | no value                | Also retry the successful values for which it returns `true`. See [Retrying values](#retrying-values). |
| `onRetry`           | `({ attempt, error, delayMs }) => void`    |                         | Called before each wait.                                                                               |
| `budget`            | `RetryBudget`                              |                         | Shared cap on retries. See [Retry budget](#retry-budget).                                              |
| `respectRetryAfter` | `boolean`                                  | `true`                  | Wait at least `error.retryAfterMs` when the error has one.                                             |
| `maxDelay`          | `Duration`                                 | no limit                | Longest delay before a retry, `retryAfterMs` included.                                                 |
| `idempotent`        | `boolean`                                  | the execution option    | Overrides `execute(fn, { idempotent })`. See [Idempotency](#idempotency).                              |

`retries` is a non-negative integer or `Infinity`. Any other value throws a `RangeError` when the policy is built.

A standalone `new Retry(options)` added with `.with()` accepts any tag in `retryOn`, because it does not know the errors of the policy. `new Retry<E>(options)` restricts them to the tags of `E`.

In the callbacks, `error` has the type of the errors of the steps added before, and `attempt` is the 1-based attempt that failed. `retryOn` accepts only the tags of these errors. When you set both `retryOn` and `retryIf`, an error is retried only if both agree.

The steps inside the retry receive the attempt number in their context, and so does your function.

## When the retry stops

The retry returns the last result as soon as one of these happens:

- An attempt succeeds, with a value that does not pass `retryIfValue`.
- The retries are exhausted.
- The error does not pass `retryOn` or `retryIf`.
- The error is a `CircuitOpenError` and `retryOn` does not list it. Retrying an open circuit only waits for it to admit calls, up to `openFor`.
- The signal aborts, during an attempt or during a delay.
- The delay is `Infinity`. See [Delays](#delays).
- The [budget](#retry-budget) is exhausted.
- The execution is not idempotent and the call already ran. See [Idempotency](#idempotency).

Callbacks must not throw. A throwing `retryIf`, `delay`, or `onRetry` is a bug, and the execution rejects with the thrown value.

## Delays

`delay` accepts:

- A duration, such as `250` or `'1s'`, for a fixed delay.
- A backoff function from `backoff`.
- A function `(attempt, error) => Duration` of the failed attempt and its error.

The default is `backoff.exponential()`: 100 ms after the first failure, doubled each time, capped at 30 seconds, with full jitter.

A delay of `Infinity`, or a `retryAfterMs` of `Infinity`, stops the retries unless `maxDelay` caps it: the retry returns the last result and emits `retry.declined` with the reason `delay`.

| Preset                         | Delay after attempt `n`                     | Options and defaults                                                   |
| ------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| `backoff.constant(delay)`      | `delay`                                     |                                                                        |
| `backoff.linear(options)`      | `base * n`, capped at `max`                 | `base: '100ms'`, `max: '30s'`, `jitter: 'none'`, `random`              |
| `backoff.exponential(options)` | `base * factor ** (n - 1)`, capped at `max` | `base: '100ms'`, `factor: 2`, `max: '30s'`, `jitter: 'full'`, `random` |

The cap applies before the jitter. `factor` must be a finite number of 1 or more, and `jitter` one of the values below: anything else throws a `RangeError`. `random` replaces `Math.random`, which helps in tests.

| Jitter  | Delay                                                                                         |
| ------- | --------------------------------------------------------------------------------------------- |
| `full`  | A random value between 0 and the computed delay. It spreads the retries of many clients best. |
| `equal` | Half the computed delay, plus a random value up to the other half.                            |
| `none`  | The computed delay.                                                                           |

### Retry-After

Some errors say when to try again in a `retryAfterMs` field: `RateLimitError`, `CircuitOpenError` when `retryOn` lists it, or an error of your own built from an HTTP `Retry-After` header. The retry waits at least `retryAfterMs` before the next attempt, up to `maxDelay`. Set `respectRetryAfter: false` to use the delay alone.

## Retry budget

A `RetryBudget` caps the share of retries across every execution that uses it. When a dependency fails, each caller retrying multiplies the load on it. A budget keeps the retries to a fraction of the traffic. Share one budget between the policies that call the same dependency.

```ts
import { RetryBudget, Tenace } from '@julr/tenace'

const budget = new RetryBudget({ ratio: 0.1 })

const getUserPolicy = Tenace.policy().withRetry({ retries: 3, budget })
const listUsersPolicy = Tenace.policy().withRetry({ retries: 3, budget })
```

| Option         | Type       | Default             | Description                                                  |
| -------------- | ---------- | ------------------- | ------------------------------------------------------------ |
| `ratio`        | `number`   | `0.2`               | Retries allowed per execution, on average over the window.   |
| `minPerSecond` | `number`   | `10`                | Retries always allowed per second, even with little traffic. |
| `window`       | `Duration` | `'10s'`             | Window over which executions and retries are counted.        |
| `clock`        | `Clock`    | the execution clock | Clock that moves the window.                                 |

Over the window, the budget allows `minPerSecond * window in seconds + ratio * executions` retries. Each execution of a retry that uses the budget counts once. When the budget is exhausted, the retry returns the last result, an error or a value rejected by `retryIfValue`, and emits `retry.declined` with the reason `budget`.

## Idempotency

Running a payment or an email twice is not safe. Pass `idempotent: false` to `execute()` or `settle()` for these calls:

```ts
import { Tenace } from '@julr/tenace'

declare function chargeCard(orderId: string): Promise<void>

const policy = Tenace.policy().withBulkhead({ concurrency: 10 }).withRetry({ retries: 3 })

await policy.execute(() => chargeCard('order-1'), { idempotent: false })
```

The retry then retries only the calls that were rejected before running: `BulkheadFullError`, `RateLimitError`, `LockNotAcquiredError`, and `CircuitOpenError` when `retryOn` lists it. For any other error that passes `retryOn` and `retryIf`, it returns the error and emits `retry.declined` with the reason `idempotency`.

The `idempotent` option of the retry overrides the option of the execution.

## Retrying values

Some calls report a failure without throwing: `fetch` resolves with a `503` response. `retryIfValue` retries these values like errors:

```ts
import { Tenace } from '@julr/tenace'

declare const url: string

const response = await Tenace.call(({ signal }) => fetch(url, { signal }))
  .withRetry({
    retries: 3,
    retryIfValue: response => response.status === 503 || response.status === 429,
  })
  .execute()
```

- Errors and values share the `retries` count, the delays, `maxDelay`, and the budget. `retryOn` and `retryIf` still apply to errors only.
- Once the retries are exhausted, the last value is returned as a success. The error channel does not change. To fail with a typed error instead, return `err(...)` from the function and retry it with `retryOn`.
- `delay` and `onRetry` receive the cause of the retry, `{ error }` or `{ value }`. Tell them apart with `'value' in cause`. A response can set the delay, for example from its `Retry-After` header:

  ```ts
  import { Tenace } from '@julr/tenace'

  declare const url: string

  await Tenace.call(({ signal }) => fetch(url, { signal }))
    .withRetry({
      retries: 3,
      retryIfValue: response => response.status === 429,
      delay: (_attempt, cause) =>
        'value' in cause ? Number(cause.value.headers.get('retry-after') ?? 1) * 1000 : 100,
    })
    .execute()
  ```

- A retried value is dropped. For a `fetch` response, release its connection in `onRetry`: `if ('value' in event) void event.value.body?.cancel()`.
- A value is never retried when the execution is not [idempotent](#idempotency): the call already ran.
- On a bound call (`Tenace.call(fn)`), `value` has the type of the value of `fn`. On a reusable policy, the function is not known yet, so `value` is `unknown`: narrow it, for example with `instanceof Response`.

## Events

| Event             | Fields                                   | When                                                                                                        |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `retry.scheduled` | `attempt`, `delayMs`, `error` or `value` | A retry is scheduled, before the wait.                                                                      |
| `retry.exhausted` | `attempts`, `error` or `value`           | The last allowed attempt failed, or returned a value `retryIfValue` rejected. Not emitted for `retries: 0`. |
| `retry.declined`  | `attempt`, `error` or `value`, `reason`  | The budget, the idempotency rule, or an `Infinity` delay stopped the retries.                               |

A retry event has `value` instead of `error` when `retryIfValue` caused it: check `'value' in event`.
