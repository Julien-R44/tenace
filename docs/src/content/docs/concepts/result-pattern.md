---
title: Result pattern
description: Why Tenace returns expected failures as values, why its Result stays small, and when to use it in your own code.
---

A function can fail in two ways. Some failures are part of its contract. The email is taken, the coupon has expired, or the bank declines the card. The caller must handle each of them, and usually handles each one differently. Other failures are bugs and outages, such as a violated invariant or a database that does not answer. Nobody handles those one by one.

A thrown error hides the first kind. `signup(email): Promise<User>` does not say that it can fail with `EmailTaken`, and TypeScript cannot check that the caller handles it. A Result puts the expected failures in the return type:

```ts
import { Result, TenaceError } from '@julr/tenace/result'

class EmailTaken extends TenaceError {
  static readonly tag = 'EmailTaken'
  readonly _tag = 'EmailTaken' as const
  readonly code = 'E_EMAIL_TAKEN' as const
}

declare function emailExists(email: string): Promise<boolean>
declare function createUser(email: string): Promise<User>

async function signup(email: string): Promise<Result<User, EmailTaken>> {
  if (await emailExists(email)) return Result.err(new EmailTaken(email))
  return Result.ok(await createUser(email))
}
```

## A Result is a plain object

`Result.ok(value)` builds `{ ok: true, value }`, and `Result.err(error)` builds `{ ok: false, error }`. Checking `result.ok` narrows the type, so `result.value` exists only on a success, and `result.error` exists only on a failure.

`Result` is a type and a namespace at once. `Result<User, EmailTaken>` is the type, and `Result.ok(user)` builds a value. Import it from `@julr/tenace`, or from `@julr/tenace/result` to load only the Results and the error classes. Both paths give the same `Result`.

Each Result carries a brand that `JSON.stringify()` and `Object.keys()` do not see. A payload that only looks like a Result, such as `{ ok: false, error: 'x' }` from an API, stays a plain value. `Result.is(value)` checks the brand, and it recognizes the Results of any copy of Tenace.

## Every layer of Tenace passes Results

Tenace uses the same Result internally, in every layer. Some examples:

- Your function returns `Result.err(error)`, and `error` joins the [error channel](/concepts/typed-errors/) of the policy.
- A strategy fails by returning `Result.err(new TimeoutError(...))` instead of throwing. The `execute()` method of a [custom strategy](/guides/custom-strategies/) returns a `Promise<Result.Any>`.
- A fallback handler returns a value, `Result.ok()`, or `Result.err()`.
- The [instrumentation](/observability/instrumentation/) hooks wrap each attempt and each execution, and get its Result back from `run()`.
- `settle()` resolves with the final Result, and `Result.match()` handles each of its errors.

The Result that a service returns is the type that goes through the policy and comes out of `settle()`. You convert nothing at the boundary.

## Small on purpose

The Result of Tenace has a type, two constructors, and a few helpers: `Result.match()`, `Result.try()`, `Result.all()`, `Result.partition()`, `Result.unwrap()`, and `Result.unwrapErr()`. It has no method chaining such as `map()` or `andThen()`, no `ResultAsync`, and no generator syntax.

Libraries such as [neverthrow](https://github.com/supermacro/neverthrow) put the control flow in methods. `andThen()` runs the next step only after a success, and `ResultAsync` wraps a promise of a Result so that you can call methods on it before it resolves. Here is a function that accepts an invite, written with neverthrow:

```ts nocheck
import { ResultAsync } from 'neverthrow'

declare function checkInvite(code: string): ResultAsync<Invite, InvalidInvite>
declare function createMember(inviteId: string): Promise<User>

function acceptInvite(code: string): ResultAsync<User, InvalidInvite> {
  return checkInvite(code).andThen(invite => {
    const member = createMember(invite.id)
    return ResultAsync.fromSafePromise(member)
  })
}
```

The same function with Tenace uses `await` and an early `return`:

```ts
import { Result, TenaceError } from '@julr/tenace/result'

class InvalidInvite extends TenaceError {
  static readonly tag = 'InvalidInvite'
  readonly _tag = 'InvalidInvite' as const
  readonly code = 'E_INVALID_INVITE' as const
}

type Invite = { id: string }

declare function checkInvite(code: string): Promise<Result<Invite, InvalidInvite>>
declare function createMember(inviteId: string): Promise<User>

async function acceptInvite(code: string): Promise<Result<User, InvalidInvite>> {
  const invite = await checkInvite(code)
  if (!invite.ok) return invite

  return Result.ok(await createMember(invite.value.id))
}
```

Both versions stop at the first failure and have the same error type. The second one is the code you already write, with one `if` per step that can fail. `return invite` needs no conversion. A failed Result holds only its error, so it fits any Result with the same error type, whatever the type of its value.

We think `await` and an early return cover most application code. If your team prefers chaining, neverthrow and [better-result](https://github.com/dmmulroy/better-result) are good choices. Tenace accepts their Results too, as [Use your own Result type](/guides/custom-result-types/) shows.

## Return expected failures, throw the rest

Use a Result in your own code when the caller decides what to do with a failure. To decide, ask whether the caller writes a different branch for that error, or returns a different HTTP status.

- Return `Result.err()` for the failures in the contract of a function. `EmailTaken` becomes a 409 response, `InvalidCoupon` becomes a 422, and `PaymentDeclined` becomes a 402.
- Throw for bugs and outages. A policy turns what you throw into an `UnexpectedError`, and an HTTP framework turns it into a 500 response.

`Result.match()` then checks that the caller handles each error. It needs one handler per error tag, so adding `InvalidCoupon` to `signup()` fails the build of every caller that does not handle it:

```ts nocheck
const result = await signup(email)

const status = Result.match(result, {
  ok: () => 201,
  EmailTaken: () => 409,
})
```

A function whose only failures are bugs keeps returning its value and throwing. A Result would add an `if` to every caller and catch nothing new.

## Next steps

- [Work with Results](/guides/results/) wraps code that throws, combines Results, and unwraps them.
- [Typed errors](/concepts/typed-errors/) shows how errors join the error channel of a policy, and how `Result.match()` treats errors without a tag.
- [`execute()` and `settle()`](/concepts/execute-and-settle/) compares the two ways to run a policy.
