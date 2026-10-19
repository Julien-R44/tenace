---
title: Shared rate limits
description: Share a rate limit between instances with Redis, Postgres, or another backend, through the rate-limiter-flexible adapter.
---

The in-memory rate limit counts the calls of one process. To count the calls of every instance against one limit, back it with [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible), which stores the counters in Redis, Valkey, Memcached, Postgres, MySQL, SQLite, MongoDB, DynamoDB, and more.

```sh
npm install rate-limiter-flexible ioredis
```

```ts
import { Tenace } from '@julr/tenace'
import { rateLimiterFlexible } from '@julr/tenace/adapters/rate-limiter-flexible'
import { Redis } from 'ioredis'
import { RateLimiterRedis } from 'rate-limiter-flexible'

const redis = new Redis({ enableOfflineQueue: false })

// 100 calls per minute and per key, for all the instances together
const limiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'tenace',
  points: 100,
  duration: 60,
})

const policy = Tenace.policy().withRateLimit({ store: rateLimiterFlexible(limiter) })

await policy.execute(() => getUser(id), { key: `user:${id}` })
```

`rateLimiterFlexible(limiter)` takes any limiter of the library: `RateLimiterPostgres`, `RateLimiterMemory` in tests, and so on. The limiter defines the limit, so pass only the `store`, not `limit` and `per`.

## Behavior

Each call consumes one point under its [key](/concepts/keys/). A rejection of the limiter becomes a `RateLimitError` with its `msBeforeNext` as `retryAfterMs`, or `Infinity` when the limit never resets (`duration: 0`). `maxWait` works as with the in-memory limiter: the call waits up to `maxWait` for the next slot.

An `Error` from the limiter, such as a lost Redis connection, fails the call with an `UnexpectedError`. To keep serving calls while Redis is down, give the limiter an `insuranceLimiter`, a `RateLimiterMemory` that takes over while the store fails.

See [Rate limit](/strategies/rate-limit/) for the other options and the events.
