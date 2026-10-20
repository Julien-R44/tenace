---
title: Typed errors
description: How a policy tracks the errors it can produce, and how your own errors join them.
---

Every policy carries the union of errors it can produce in its type. This union is the error channel. Strategies add errors to it, fallbacks remove them, and functions that return a `Result` add their own.

```ts
import { Tenace } from '@julr/tenace'

const result = await Tenace.policy()
  .withTimeout('1s') // adds TimeoutError
  .withCircuitBreaker() // adds CircuitOpenError
  .withFallbackOn(['CircuitOpenError'], () => null) // removes CircuitOpenError
  .settle(() => getUser(id))
//    ^? Result<User | null, UnexpectedError | TimeoutError>
```

## Where errors come from

- **Thrown values.** Anything your function throws becomes an `UnexpectedError`. Every channel contains `UnexpectedError`, because any function can throw.
- **Returned errors.** A function that returns `Result.err(error)`, or a promise of it, adds the type of `error` to the channel. A function typed to return `unknown` or `any` may return any `Result.err(...)`, so its error channel is `unknown`.
- **Strategies.** Each strategy declares what it adds and removes. The [error reference](/reference/errors/) lists the errors Tenace produces.

Thrown values stay outside the channel on purpose. TypeScript cannot know what a function throws, so a type that claims to know would lie. A function that wants its errors typed returns them.

## Define an error

An error is typed by its `_tag`, a string literal that tells it apart from the other members of the union. Extend `TenaceError`, declare `_tag` and `code` as literal fields, and return the error with `Result.err()`:

```ts
import { Result, Tenace, TenaceError } from '@julr/tenace'

class NotFound extends TenaceError {
  static readonly tag = 'NotFound'
  readonly _tag = 'NotFound' as const
  readonly code = 'E_NOT_FOUND' as const
}

declare const db: { find(id: string): Promise<User | undefined> }

async function findUser(id: string): Promise<Result<User, NotFound>> {
  const user = await db.find(id)
  return user ? Result.ok(user) : Result.err(new NotFound(`user ${id}`))
}

const result = await Tenace.policy()
  .withTimeout('1s')
  .settle(() => findUser(id))
//    ^? Result<User, NotFound | UnexpectedError | TimeoutError>

if (!result.ok && result.error instanceof NotFound) {
  console.log(result.error.message)
}
```

`TenaceError` gives you:

- `code`, a stable identifier for logs and serialization, such as `E_NOT_FOUND`.
- `name`, set to the `static readonly tag` of the class, or to the class name without it. Declare the tag for a stable name: minifiers rename classes.
- `toJSON()`, which returns the tag, the code, the name, the message, the own fields, and the cause, without the stack trace.
- An `instanceof` check that works across duplicated copies of the package. With `static readonly tag` set to the value of `_tag`, `instanceof NotFound` also works across copies of your own class. `instanceof` also checks the prototype chain, so a subclass of `NotFound` with its own tag is still a `NotFound`.

`isTenaceError(value)` returns `true` for any error created by any copy of Tenace.

Errors do not have to extend `TenaceError`. Any object with a literal `_tag` works with `retryOn`, `withFallbackOn()`, and `Result.match()`, such as the exceptions of your framework: see [Use with AdonisJS](/guides/adonisjs/). Errors without a `_tag`, such as a string, still flow through the channel, and only the handlers that take every error can handle them: `withFallback()`, `withFallbackWhen()`, `mapError()`, `retryIf`, and the `_` case of `Result.match()`. `withFallbackWhen()` handles them but does not remove them from the channel, because a type guard on an untagged class proves nothing about what it matches at runtime.

## Match a Result

`Result.match(result, handlers)` calls the `ok` handler or the handler named after the error `_tag`, and returns what the handler returns. It is exhaustive. TypeScript reports a missing tag, and a handler for a tag that the result cannot contain.

```ts
import { Result, Tenace } from '@julr/tenace'

const result = await Tenace.policy()
  .withTimeout('1s')
  .settle(() => getUser(id))

const message = Result.match(result, {
  ok: user => `Hello ${user.name}`,
  TimeoutError: error => `Timed out after ${error.timeoutMs}ms`,
  UnexpectedError: error => `Failed: ${String(error.cause)}`,
})
```

A `_` handler takes every error without its own handler, including untagged errors. It is required when the error type has untagged members, such as strings, plain `Error`s, or `unknown`. At runtime, an error with no matching handler and no `_` is rethrown. Only untyped input can cause that.

## Read the errors of a policy

`ErrorOf<typeof policy>` is the error channel of a policy, without the undeclared errors (`OtherError`):

```ts
import { type ErrorOf, Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s').withCircuitBreaker()

type PolicyError = ErrorOf<typeof policy> // UnexpectedError | TimeoutError | CircuitOpenError
```

The callbacks of a reusable policy also receive `OtherError`, so a predicate typed with `ErrorOf` cannot be passed to them. Type it with `CurrentError`, which includes `OtherError`:

```ts
import { type CurrentError, Tenace } from '@julr/tenace'

const base = Tenace.policy().withTimeout('1s')

const isTransient = (error: CurrentError<typeof base>): boolean => error._tag === 'TimeoutError'

const policy = base.withRetry({ retries: 2, retryIf: isTransient })
```

The final `Result` type of `settle(fn)` is always exact for `fn`. What the callbacks of a reusable policy can see about the errors of `fn` is the subject of [Reusable and bound policies](/concepts/reusable-and-bound-policies/).
