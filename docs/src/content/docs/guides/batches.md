---
title: Run batches
description: Run many functions through one policy with bounded concurrency, fail-fast or settling every task.
---

`Tenace.all()` and `Tenace.map()` run several functions through one policy, with a limit on how many run at the same time. Each function is a separate execution of the policy, with its own timeouts and retries. Stateful strategies, such as a circuit breaker, are shared by every task.

## Run a fixed list of functions

`Tenace.all(tasks, options)` takes an array of functions. `execute()` resolves with their values, in order, typed as a tuple:

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s').withRetry({ retries: 2 })

const [user, posts] = await Tenace.all([() => getUser(id), () => getPosts(id)], {
  policy,
}).execute()
```

## Map a list of items

`Tenace.map(items, fn, options)` calls `fn` for each item of an iterable. `fn` receives the item, the [context](/concepts/cancellation/) of its execution, and the index:

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s').withRetry({ retries: 2 })

const users = await Tenace.map(ids, (userId, { signal }) => fetchUser(userId, { signal }), {
  policy,
  concurrency: 5,
}).execute()
```

## Options

| Option        | Type     | Default         | Description                                                             |
| ------------- | -------- | --------------- | ----------------------------------------------------------------------- |
| `policy`      | `Policy` | an empty policy | The reusable policy every task runs through.                            |
| `concurrency` | `number` | every task      | Tasks running at the same time. An integer of 1 or more, or `Infinity`. |

An invalid `concurrency` throws a `RangeError` when the batch is created.

`execute()` and `settle()` accept a `signal` and a `clock`, which reach every task.

## Stop at the first failure

`execute()` is fail-fast. The first failure rejects the batch, like [`policy.execute()`](/concepts/execute-and-settle/): with the raw thrown value, or with the known error. It also aborts the signal of the tasks still running, with an `AbortError` whose message is `A sibling task of the batch failed`, and skips the tasks that have not started.

`policy.isError(error)` recognizes the known errors a batch rejects with.

## Get one Result per task

`settle()` runs every task and resolves with one `Result` per task, in order. A failure does not stop the other tasks:

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s')

const results = await Tenace.map(ids, userId => getUser(userId), { policy }).settle()

const found = results.filter(result => result.ok).map(result => result.value)
```

Like `policy.settle()`, `settle()` rejects only when the caller aborts its signal, or when a strategy or a callback throws.

## Cancel a batch

Aborting the signal passed to `execute()` or `settle()` aborts every task, and the batch rejects with `signal.reason`:

```ts
import { Tenace } from '@julr/tenace'

const controller = new AbortController()

const batch = Tenace.map(ids, (userId, { signal }) => fetchUser(userId, { signal })).execute({
  signal: controller.signal,
})

controller.abort()
await batch.catch(() => {}) // rejects with the AbortError of the controller
```
