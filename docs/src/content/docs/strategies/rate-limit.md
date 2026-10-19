---
title: Rate limit
description: Limit the call rate per key, in memory or in a shared store, and optionally wait for a slot.
---

A rate limit caps how many calls run per period. A call over the limit fails with `RateLimitError`, or waits for a slot when you allow it.

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withRateLimit({ limit: 10, per: '1s', maxWait: '500ms' })

await policy.execute(() => getUser(id), { key: `user:${id}` })
```

## API

```ts nocheck
policy.withRateLimit(rateLimit: RateLimit | RateLimitOptions)
new RateLimit(options: RateLimitOptions)
```

Pass either `limit` and `per` for the in-memory limiter, or a `store`:

| Option    | Type             | Default                             | Description                                                             |
| --------- | ---------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `limit`   | `number`         | required without `store`            | Calls allowed per `per`. An integer of 1 or more.                       |
| `per`     | `Duration`       | required without `store`            | The period.                                                             |
| `store`   | `RateLimitStore` | a `MemoryRateLimitStore`            | Where calls are counted. Replaces `limit` and `per`.                    |
| `key`     | `string`         | the execution key, then `'default'` | Key to count calls against. See [Keys](/guides/keys-and-adapters/).     |
| `maxWait` | `Duration`       | `0`                                 | Wait for a slot instead of failing, when the wait is at most this long. |
| `clock`   | `Clock`          | the execution clock                 | Clock that gives the store the current time.                            |

Share the `RateLimit` instance, or the store, to share the limit between policies.

## Behavior

The default store, `MemoryRateLimitStore`, is a token bucket per key. A bucket holds up to `limit` tokens and refills continuously at `limit` tokens per `per`. A call takes one token. Bursts of up to `limit` calls pass at once. A key unused for `per`, whose bucket is full again, is forgotten, so the memory stays bounded. `store.size` returns the number of keys tracked.

When no token is left, the store says when the next one arrives. If that wait fits in `maxWait`, the call waits, then asks again. Otherwise it fails with `RateLimitError`. A wait stops when the signal aborts, and the call fails like any aborted call, not with a `RateLimitError`.

A retry outside the rate limit waits at least `retryAfterMs` before the next attempt. See [Retry-After](/strategies/retry/#retry-after).

## Error channel

Adds `RateLimitError`, with these fields:

- `key`: the key that ran out of calls.
- `retryAfterMs`: when a call may be admitted again.

## Stores

```ts nocheck
interface RateLimitStore {
  consume(key: string, now: number): RateLimitDecision | Promise<RateLimitDecision>
}

interface RateLimitDecision {
  readonly allowed: boolean
  readonly retryAfterMs: number // 0 when allowed
}
```

`consume()` takes one call from the key and returns whether it is allowed. For a limit shared between processes, use the [`rate-limiter-flexible` adapter](/guides/keys-and-adapters/#rate-limiter-flexible) or implement the interface.

A store that throws or rejects fails the call with an `UnexpectedError` whose `cause` is the store error. `execute()` rejects with the store error itself, like any throw.

## Events

| Event                 | Fields                | When                |
| --------------------- | --------------------- | ------------------- |
| `rate_limit.rejected` | `key`, `retryAfterMs` | A call is rejected. |
