---
title: execute() and settle()
description: The two ways to run a policy, and what each one does with errors.
---

A policy runs a function in one of two ways. `execute()` returns a promise that resolves with the value or rejects, like any async call. `settle()` returns a promise of a `Result` that holds either the value or a typed error.

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s')

// resolves with a User, or rejects
const user = await policy.execute(() => getUser(id))

// resolves with a Result<User, TimeoutError | UnexpectedError>
const result = await policy.settle(() => getUser(id))
```

## What each method does with an outcome

|                                                                                 | `execute(fn)`                     | `settle(fn)`                                                |
| ------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `fn` succeeds                                                                   | resolves with the value           | `{ ok: true, value }`                                       |
| `fn` throws                                                                     | rejects with the raw thrown value | `{ ok: false, error }` with an `UnexpectedError` in `error` |
| `fn` returns `err(e)`, or a strategy fails (`TimeoutError`, `CircuitOpenError`) | rejects with the error            | `{ ok: false, error }`                                      |
| The caller aborts its signal                                                    | rejects with `signal.reason`      | rejects with `signal.reason`                                |
| A strategy or a callback throws, or `fn` is not a function                      | rejects with the thrown value     | rejects with the thrown value                               |

`execute()` never wraps what your function throws. Code that catches errors around a plain call keeps working when you add a policy.

`settle()` wraps a thrown value in an `UnexpectedError` and keeps the raw value in `error.cause`. The two last rows are the only cases where `settle()` rejects. A caller abort is outside the error channel, like an aborted `fetch`. A throwing strategy or callback is a bug, because strategies and callbacks return their failures as `err(...)`.

## Tell known errors apart with isError()

A value caught from `execute()` can be anything your function threw, or one of the errors the policy knows. `policy.isError(error)` returns `true` for the second kind and narrows the type:

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s')

try {
  await policy.execute(() => getUser(id))
} catch (error) {
  if (policy.isError(error)) {
    console.log(error._tag) // 'TimeoutError', or undefined for an undeclared error
  } else {
    throw error // what getUser threw, untouched
  }
}
```

The narrowed type includes `OtherError`, because `execute()` also rejects with the errors your function returns. `isError()` recognizes only the error objects that `execute()` of the same policy object rejected with. A policy derived with another method, such as `policy.withRetry(...)`, is a different object with its own record. Primitive errors, such as `err('nope')`, are never recognized.

## Results

A `Result` is a plain object: `{ ok: true, value }` or `{ ok: false, error }`. Build one with `ok()` and `err()`, and check `result.ok` to narrow it:

```ts
import { err, ok, type Result } from '@julr/tenace'

function parsePort(input: string): Result<number, string> {
  const port = Number(input)
  return Number.isInteger(port) ? ok(port) : err(`invalid port: ${input}`)
}

const result = parsePort('8080')
if (result.ok) console.log(result.value + 1)
else console.log(result.error)
```

Results carry a non-enumerable brand. A value your function returns that only looks like a Result, such as `{ ok: false, error: 'x' }` from an API payload, stays a plain value. `isResult(value)` checks the brand, and recognizes Results created by any copy of Tenace.

When your function returns `ok(value)`, `execute()` resolves with `value`. When it returns `err(error)`, the error joins the error channel. See [Typed errors](/concepts/typed-errors/).

## Choose one

Use `execute()` at the edges where a rejection is the normal way to fail: HTTP handlers, jobs, code that already catches. Use `settle()` when the caller handles each error, and let [`match()`](/concepts/typed-errors/#match-a-result) check that no case is missing.
