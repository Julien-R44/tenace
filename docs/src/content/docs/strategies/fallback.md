---
title: Fallback and mapError
description: Replace errors with a value or another error, by tag, by predicate, or all of them.
---

A fallback handles the errors of the steps added before it. Its handler returns a value that replaces the error, or another error. The handled errors leave the error channel.

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy()
  .withTimeout('1s')
  .withCircuitBreaker()
  .withFallbackOn(['TimeoutError', 'CircuitOpenError'], () => null)

const user = await policy.execute(() => getUser(id)) // User | null
```

## API

| Method                            | Handles                                        | Removes from the channel               |
| --------------------------------- | ---------------------------------------------- | -------------------------------------- |
| `withFallback(handler)`           | every error                                    | every error                            |
| `withFallbackOn(tags, handler)`   | the errors whose `_tag` is in `tags`           | those errors                           |
| `withFallbackWhen(when, handler)` | the errors for which `when` returns `true`     | see [Predicates](#predicates)          |
| `mapError(mapper)`                | every error, replaced by what `mapper` returns | every error, then adds the mapped type |

`tags` accepts only the tags of the errors of the steps added before. The handler receives the error, narrowed to what it handles, and the [context](/concepts/cancellation/) of the execution.

### What the handler returns

- A value: the execution succeeds with it. Its type joins the value type of the policy.
- `Result.ok(value)`: the same.
- `Result.err(error)`: the execution fails with `error`, which joins the error channel.
- A [registered foreign Result](/guides/custom-result-types/).
- A promise of any of these.

```ts
import { Result, Tenace, TenaceError } from '@julr/tenace'

class ServiceUnavailable extends TenaceError {
  readonly _tag = 'ServiceUnavailable' as const
  readonly code = 'E_SERVICE_UNAVAILABLE' as const
}

declare const cache: { get(key: string): Promise<User | undefined> }

const policy = Tenace.policy()
  .withTimeout('1s')
  .withFallbackOn(['TimeoutError'], async () => {
    const cached = await cache.get(`user:${id}`)
    return cached ?? Result.err(new ServiceUnavailable('users API timed out, nothing cached'))
  })

const result = await policy.settle(() => getUser(id))
//    ^? Result<User, UnexpectedError | ServiceUnavailable>
```

The handler must not throw. A throwing handler is a bug, and the execution rejects with the thrown value. Return `Result.err(...)` to fail on purpose.

A fallback does not run when the signal is aborted.

### Predicates

`withFallbackWhen(when, handler)` handles the errors for which `when` returns `true`. What leaves the channel depends on `when`:

- **A type guard** narrows the error the handler receives, and removes the guarded errors from the channel when they all have a literal `_tag`. On TypeScript 5.5 and later, `error => error instanceof NotFound` is inferred as a type guard. A guard on untagged classes removes nothing, because they match structurally.
- **A plain predicate** handles the errors it matches and removes nothing. The handler receives every error of the channel.

Types are compared by structure. A subclass that adds nothing to its parent, such as `class NotFound extends HttpError {}`, is the same type as `HttpError`: a guard on it removes `HttpError` from the channel too, although `instanceof NotFound` is `false` for an `HttpError` at runtime. Give a guarded subclass its own `_tag`, or a member of its own:

```ts
import { Tenace, TenaceError } from '@julr/tenace'

class ApiError extends TenaceError {
  readonly _tag: 'ApiError' | 'ApiNotFound' = 'ApiError'
  readonly code = 'E_API' as const
}

class ApiNotFound extends ApiError {
  override readonly _tag = 'ApiNotFound' as const
}

const policy = Tenace.policy<ApiError>().withFallbackWhen(
  error => error instanceof ApiNotFound,
  () => null,
)
// ApiNotFound is handled, ApiError stays in the channel
```

Use a plain predicate when only some errors of a type are handled, such as an `HttpError` with status 404. A condition that also checks a field is not inferred as a type guard, so it stays a plain predicate:

```ts
import { Tenace } from '@julr/tenace'

const body = await Tenace.call(() => request('/users'))
  .withFallbackWhen(
    error => error instanceof HttpError && error.status === 404,
    () => '[]',
  )
  .execute()
```

`HttpError` stays in the channel, because an `HttpError` with another status still fails. Do not annotate such a condition as a type guard (`(error): error is HttpError => ...`): TypeScript trusts the annotation and removes `HttpError` from the channel, although some still fail at runtime. A dedicated error type, such as `NotFound`, lets a type guard keep the channel accurate.

## mapError

`mapError(mapper)` replaces every error of the steps added before with what `mapper` returns. The error channel becomes the return type of `mapper`. Successes pass through.

In a reusable policy, a mapper or a fallback handler that passes an undeclared error along, such as `error => (error._tag === 'TimeoutError' ? new Wrapped('timed out') : error)`, has `OtherError` in its return type. That `OtherError` stands for every error that reached the step, so they all stay in the channel.

```ts
import { Tenace, TenaceError } from '@julr/tenace'

class UsersUnavailable extends TenaceError {
  readonly _tag = 'UsersUnavailable' as const
  readonly code = 'E_USERS_UNAVAILABLE' as const
}

const policy = Tenace.policy()
  .withTimeout('1s')
  .mapError(error => new UsersUnavailable('users API failed', { cause: error }))
```

The mapper must not throw. `execute()` rejects with the mapped error, and `policy.isError()` recognizes it.

## Classes

The `Fallback` and `MapError` classes are exported for custom code. Added with `.with()`, they are typed like the methods: `new Fallback(handler)` removes every error and adds what `handler` returns, `new Fallback(handler, when)` removes the guarded errors by tag, like `withFallbackWhen()`, and `new MapError(mapper)` replaces the channel with what `mapper` returns.

## Events

| Event           | Fields  | When                                  |
| --------------- | ------- | ------------------------------------- |
| `fallback.used` | `error` | A fallback handler runs for an error. |

`mapError` emits no event.
