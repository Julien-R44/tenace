---
title: Use your own Result type
description: Register a Result library you already use, so functions that return it contribute their value and error types.
---

A function that returns a Tenace `Result` adds its errors to the error channel. If your code already returns another Result type, such as the one of [neverthrow](https://github.com/supermacro/neverthrow) or one of your own, register it once. Tenace then unwraps it at runtime and in the types.

The registration has a type half and a runtime half. This guide registers a homemade Result type:

```ts
export class AppOk<T> {
  readonly success = true as const
  readonly data: T

  constructor(data: T) {
    this.data = data
  }
}

export class AppErr<E> {
  readonly success = false as const
  readonly failure: E

  constructor(failure: E) {
    this.failure = failure
  }
}

export type AppResult<T, E> = AppOk<T> | AppErr<E>
```

## Declare the types

Augment the `ResultTypes` interface of `@julr/tenace`. Each entry maps a member of the returned type to a `[value, error]` tuple, or to `never` when the member is not one of its results:

```ts nocheck
declare module '@julr/tenace' {
  interface ResultTypes<R> {
    app: R extends AppOk<infer T> ? [T, never] : R extends AppErr<infer E> ? [never, E] : never
  }
}
```

The entry name, `app` here, is the name you register at runtime.

## Register the adapter

`registerResult(name, adapter)` registers a function that converts one of your results to a Tenace Result. It returns `undefined` for any other value:

```ts nocheck
import { registerResult, Result } from '@julr/tenace'

registerResult('app', value =>
  value instanceof AppOk
    ? Result.ok(value.data)
    : value instanceof AppErr
      ? Result.err(value.failure)
      : undefined,
)
```

Run it once, before the first execution, for example in the module that defines the Result type. The registry is global, so it works across copies of Tenace in the same process. Registering the same name again replaces the adapter, and `unregisterResult(name)` removes it.

## Use it

Functions that return your Result type now behave like functions that return a Tenace Result:

```ts nocheck
import { Tenace, TenaceError } from '@julr/tenace'

class NotFound extends TenaceError {
  readonly _tag = 'NotFound' as const
  readonly code = 'E_NOT_FOUND' as const
}

declare function findUser(id: string): Promise<AppResult<User, NotFound>>

const user = await Tenace.policy()
  .withTimeout('1s')
  .execute(() => findUser(id))
//    ^? User

const result = await Tenace.policy()
  .withTimeout('1s')
  .settle(() => findUser(id))
//    ^? Result<User, NotFound | UnexpectedError | TimeoutError>
```

Fallback handlers can return your Result type too.

An adapter that throws is treated like a throwing function: the execution gets an `UnexpectedError` with the thrown value as its cause. When no adapter is registered, your results are plain values: `execute()` resolves with the `AppErr` object itself.
