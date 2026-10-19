---
title: Reusable and bound policies
description: Tenace.policy() runs any function, Tenace.call(fn) binds one. What changes for the types of your callbacks.
---

Tenace builds a policy in two ways. `Tenace.policy()` creates a reusable policy that runs any function you pass to `execute(fn)` or `settle(fn)`. `Tenace.call(fn)` creates a policy bound to one function, and its `execute()` and `settle()` take no function.

```ts
import { Tenace } from '@julr/tenace'

// reusable: build it once, run many functions through it
const users = Tenace.policy({ name: 'users' }).withTimeout('1s')
await users.execute(() => getUser('1'))
await users.execute(() => getUser('2'))

// bound: build it around one call
const posts = await Tenace.call(() => getPosts(id))
  .withTimeout('1s')
  .execute()
```

Both accept the same [policy options](/reference/api/#policyoptions): a `name` for instrumentation and an `instrumentation`. Both return the same `Policy` class, with the same methods.

## What callbacks can see

The difference is in the types of the callbacks: `retryIf`, `retryOn`, fallback handlers, and `mapError`.

A reusable policy is built before it knows the functions it will run. Its callbacks see the errors the strategies add, plus an opaque `OtherError` that stands for whatever the functions return. The final `Result` type stays exact, because `settle(fn)` computes it from `fn`.

```ts
import { err, type Result, Tenace, TenaceError } from '@julr/tenace'

class HttpError extends TenaceError {
  readonly _tag = 'HttpError' as const
  readonly code = 'E_HTTP' as const
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

declare function request(path: string): Promise<Result<string, HttpError>>

const policy = Tenace.policy().withRetry({
  retries: 2,
  // error is UnexpectedError | OtherError here: error.status is a type error
  retryIf: error => error._tag !== 'UnexpectedError', // returned errors, not throws
})

const result = await policy.settle(() => request('/users'))
//    ^? Result<string, HttpError | UnexpectedError>
```

A callback can pass `OtherError` along, or compare `_tag` with a tag the channel already contains, such as `'TimeoutError'`. It cannot narrow an undeclared error: `error instanceof HttpError` narrows it to `never`, and `error._tag === 'HttpError'` is a type error.

There are two ways to make the errors of your functions visible to the callbacks.

**Declare them on the reusable policy.** `Tenace.policy<E>()` tells the callbacks that the functions may return `E`:

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy<HttpError>().withRetry({
  retries: 2,
  retryIf: error => error._tag === 'HttpError' && error.status >= 500,
})
```

**Bind the function.** With `Tenace.call(fn)`, the callbacks see the exact errors of `fn`:

```ts
import { Tenace } from '@julr/tenace'

const body = await Tenace.call(() => request('/users'))
  .withRetry({
    retries: 2,
    retryIf: error => error._tag === 'HttpError' && error.status >= 500,
  })
  .withFallbackOn(['HttpError'], () => '[]')
  .execute()
```

## Choose one

Use `Tenace.policy()` for a policy you share, such as one per dependency, built at startup and reused by every call to that dependency. Its strategies keep their state between executions, which a circuit breaker or a bulkhead needs.

Use `Tenace.call(fn)` for a one-off call whose callbacks inspect the errors of the function. A bound policy cannot be added to another policy with `.with()`. Add the reusable parts to it instead:

```ts
import { CircuitBreaker, Tenace } from '@julr/tenace'

const breaker = new CircuitBreaker()
const usersApi = Tenace.policy().withTimeout('1s').with(breaker)

const user = await Tenace.call(() => getUser(id))
  .with(usersApi)
  .withFallback(() => null)
  .execute()
```

`Tenace.call()` throws a `TypeError` when its argument is not a function. The `execute()` and `settle()` methods of a reusable policy reject with a `TypeError` when they get no function.

## Type a policy parameter

A function that runs functions through a policy it receives takes a `ReusablePolicy`. It accepts any policy built with `Tenace.policy()`, and can extend it:

```ts
import { type ReusablePolicy, Tenace } from '@julr/tenace'

async function loadUser(policy: ReusablePolicy, id: string): Promise<unknown> {
  return policy.withTimeout('1s').execute(() => getUser(id))
}

await loadUser(Tenace.policy().withRetry({ retries: 2 }), '1')
```

Its fallbacks may succeed with any value, so `execute()` resolves with `unknown`. `ReusablePolicy<never>` only accepts policies without fallback values, and `execute(fn)` then resolves with the value of `fn`:

```ts
import type { ReusablePolicy } from '@julr/tenace'

async function loadUser(policy: ReusablePolicy<never>, id: string): Promise<User> {
  return policy.execute(() => getUser(id))
}
```

`AnyPolicy` is any policy, bound or not. It may be bound, so it cannot run a function: use it to store or inspect policies.

A generic wrapper cannot return `Promise<T>`: `execute()` unwraps a Result returned by the function, and `T` may be one. Return `ValueOfReturn<Awaited<T>>`:

```ts
import { Tenace, type ValueOfReturn } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s')

// `Promise<T>` is a type error
async function withPolicy<T>(fn: () => Promise<T>): Promise<ValueOfReturn<Awaited<T>>> {
  return policy.execute(fn)
}

const body = await withPolicy(() => request('/users')) // string
```
