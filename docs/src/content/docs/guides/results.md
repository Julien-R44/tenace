---
title: Work with Results
description: Wrap code that throws, combine Results, unwrap them, and avoid the mistakes that hide a failure.
---

This guide uses the helpers of `Result` in your own code, with or without a policy. To learn what a Result is and when to return one, read [Result pattern](/concepts/result-pattern/) first.

## Wrap code that throws

`Result.try(fn)` runs `fn` and returns its value as an ok Result. If `fn` throws, the Result holds an `UnexpectedError`, with the thrown value in `error.cause`. To build your own error instead, pass `{ try, catch }`. `catch` receives what `try` throws.

```ts
import { Result, TenaceError } from '@julr/tenace/result'

class InvalidUrl extends TenaceError {
  static readonly tag = 'InvalidUrl'
  readonly _tag = 'InvalidUrl' as const
  readonly code = 'E_INVALID_URL' as const
}

declare const input: string

const config = Result.try(() => JSON.parse(input))
//    ^? Result<any, UnexpectedError>

const url = Result.try({
  try: () => new URL(input),
  catch: cause => new InvalidUrl(input, { cause }),
})
//    ^? Result<URL, InvalidUrl>

const user = await Result.try(() => getUser(id))
//    ^? Result<User, UnexpectedError>
```

If `fn` returns a promise, `Result.try()` returns a promise of a Result, and a rejection becomes the error. If `fn` returns a promise only sometimes, as `cached ?? fetchUser(id)` does, the type is a Result or a promise of one. `await` it to get the Result. The same applies when `fn` is typed to return `unknown`.

If `fn` returns a Result, `Result.try()` returns that Result as is, not nested. With a `findUser()` that returns `Result<User, NotFound>`, `Result.try(() => findUser(id))` resolves with a `Result<User, NotFound | UnexpectedError>`.

`catch` must not throw. `Result.try()` does not retry or time out. For that, run the function through a policy and call `settle()`.

## Combine Results

`Result.all(results)` returns the values of every Result in order, or the first error in input order. A tuple keeps the type of each value:

```ts
import { Result } from '@julr/tenace/result'

declare function parseRow(line: string): Result<{ email: string }, 'invalid_row'>
declare const lines: string[]

const rows = Result.all(lines.map(parseRow))
//    ^? Result<{ email: string }[], 'invalid_row'>

const pair = Result.all([Result.ok(1), parseRow('a@b.c')])
//    ^? Result<[number, { email: string }], 'invalid_row'>
```

To report every invalid row instead of the first one, use `Result.partition(results)`. It returns `{ values, errors }`, each in input order:

```ts nocheck
const { values, errors } = Result.partition(lines.map(parseRow))
```

To run functions concurrently and get one Result per function, use a [batch](/guides/batches/) instead.

## Unwrap a Result

`Result.unwrap(result)` returns the value of an ok Result. Otherwise it throws what `execute()` would reject with: the error, or the raw thrown value that an `UnexpectedError` holds. Use it where a thrown error is the normal way to fail, such as an HTTP handler behind an error handler.

`Result.unwrapErr(result, tag?)` returns the error, and throws if the Result is ok. With a tag, it also throws if the error has another `_tag`, and it narrows the type of the error. Tests use it the most:

```ts nocheck
const error = Result.unwrapErr(await signup('taken@example.com'), 'EmailTaken')
//    ^? EmailTaken
```

A tag that the Result cannot contain is a type error.

## Avoid the mistakes that hide a failure

- **A callback that commits when it resolves.** A managed database transaction, such as `db.transaction(async trx => ...)`, commits when its callback resolves. If the callback returns `Result.err()`, the transaction commits. Check the expected failures before the transaction, or throw inside it to roll back.
- **A Result that goes through JSON.** `JSON.stringify()`, `structuredClone()`, and spreading drop the brand of a Result. A Result that you read back from a queue or a cache is a plain object, and `Result.is()` returns `false` for it. Build a new Result from it with `Result.ok()` or `Result.err()`.
- **A Result that nobody reads.** TypeScript does not report a Result that you never check. If `deleteUser(id)` returns `Result<void, NotFound>`, `await deleteUser(id)` alone ignores the `NotFound`.
