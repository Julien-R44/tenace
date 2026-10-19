---
title: Errors
description: Every error class Tenace produces, with its tag, code, and fields.
---

Every error extends `TenaceError` and has a literal `_tag`, a stable `code`, and a `name` equal to the class name. Import them from `@julr/tenace`.

| Class                  | `_tag` and `code`                             | Produced by                                     | Fields                    |
| ---------------------- | --------------------------------------------- | ----------------------------------------------- | ------------------------- |
| `UnexpectedError`      | `UnexpectedError`, `E_UNEXPECTED`             | any throw                                       | `cause`: the thrown value |
| `TimeoutError`         | `TimeoutError`, `E_TIMEOUT`                   | [Timeout](/strategies/timeout/)                 | `timeoutMs`               |
| `CircuitOpenError`     | `CircuitOpenError`, `E_CIRCUIT_OPEN`          | [Circuit breaker](/strategies/circuit-breaker/) | `state`, `retryAfterMs`   |
| `BulkheadFullError`    | `BulkheadFullError`, `E_BULKHEAD_FULL`        | [Bulkhead](/strategies/bulkhead/)               | `running`, `queued`       |
| `RateLimitError`       | `RateLimitError`, `E_RATE_LIMIT`              | [Rate limit](/strategies/rate-limit/)           | `key`, `retryAfterMs`     |
| `LockNotAcquiredError` | `LockNotAcquiredError`, `E_LOCK_NOT_ACQUIRED` | [Lock](/strategies/lock/)                       | `key`                     |
| `ChaosError`           | `ChaosError`, `E_CHAOS`                       | [Chaos](/strategies/chaos/), thrown             | none                      |

## UnexpectedError

`UnexpectedError` wraps anything your function threw. Its `cause` holds the raw value and its `message` copies the message of the cause. `execute()` rejects with the cause itself, and `settle()` returns the `UnexpectedError`. A failure inside a strategy that is not a bug, such as a lock provider that cannot reach Redis, is an `UnexpectedError` too.

## CircuitOpenError

| Field          | Type                                  | Description                                                  |
| -------------- | ------------------------------------- | ------------------------------------------------------------ |
| `state`        | `'open' \| 'half-open' \| 'isolated'` | The state of the circuit when it rejected the call.          |
| `retryAfterMs` | `number \| undefined`                 | When a new call may be admitted. `undefined` while isolated. |

## TenaceError

| Member                                | Description                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `_tag`                                | The literal discriminant of the error union.                                                           |
| `code`                                | A stable `E_*` identifier, for logs and serialization.                                                 |
| `name`                                | The class name. Not an enumerable field.                                                               |
| `toJSON()`                            | The tag, the code, the name, the message, the own enumerable fields, and the cause, without the stack. |
| `new TenaceError(message, { cause })` | The constructor of the subclasses.                                                                     |

`instanceof TenaceError` and `isTenaceError(value)` recognize errors from any copy of the package. `instanceof` on a subclass with a `static readonly tag` compares the tags, so it also works across copies. See [Define an error](/concepts/typed-errors/#define-an-error).
