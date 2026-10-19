---
title: Keys
description: Give each execution a key for dedupe, cache, locks, rate limits, and stale fallbacks.
---

Some strategies work per key: dedupe, cache, lock, rate limit, and stale fallback. A key names what the call is about, such as `user:42`.

## Pass a key per execution

The `key` option of `execute()` and `settle()` sets the key of the execution:

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withDedupe().withStaleFallback()

await policy.execute(() => getUser(id), { key: `user:${id}` })
```

Each strategy uses its own `key` option when it has one, and the execution key otherwise:

| Strategy       | Without any key            |
| -------------- | -------------------------- |
| Rate limit     | uses `'default'`           |
| Dedupe         | rejects with a `TypeError` |
| Stale fallback | rejects with a `TypeError` |
| Lock           | rejects with a `TypeError` |
| Cache          | rejects with a `TypeError` |

Set the key on the strategy for a value that is the same for every call, such as a lock on a nightly job. Set it on the execution for a value that changes with each call, such as a user ID.

A rate limit without a key counts every call against the `'default'` key. The other strategies need a key, so a reusable policy never merges the calls of different functions or serves the value of one function to another.

## Keys across instances

With a shared backend, the key is also the name of the value in that backend. Two processes that use the same key share the same rate limit, lock, or cached value. See [Running on multiple instances](/distributed/overview/).
