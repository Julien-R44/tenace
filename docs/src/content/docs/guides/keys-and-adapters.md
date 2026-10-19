---
title: Keys and adapters
description: Give each execution a key for dedupe, cache, locks, rate limits, and stale fallbacks, and plug in Redis-backed providers.
---

Some strategies work per key: dedupe, cache, lock, rate limit, and stale fallback. A key names what the call is about, such as `user:42`. Tenace ships adapters for three libraries that provide distributed backends.

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

## Use the adapters

The adapters are structural. They describe the part of each library that Tenace calls, and they import nothing at runtime. Install the library yourself.

### rate-limiter-flexible

`rateLimiterFlexible(limiter)` turns a [`rate-limiter-flexible`](https://github.com/animir/node-rate-limiter-flexible) limiter into a rate limit store. The limiter defines the limit, so pass only the `store`:

```ts
import { Tenace } from '@julr/tenace'
import { rateLimiterFlexible } from '@julr/tenace/adapters/rate-limiter-flexible'
import { RateLimiterMemory } from 'rate-limiter-flexible'

// 100 calls per minute and per key. Use RateLimiterRedis to share the limit between processes.
const limiter = new RateLimiterMemory({ points: 100, duration: 60 })

const policy = Tenace.policy().withRateLimit({ store: rateLimiterFlexible(limiter) })

await policy.execute(() => getUser(id), { key: `user:${id}` })
```

Each call consumes one point. A rejection of the limiter becomes a `RateLimitError` with its `msBeforeNext` as `retryAfterMs`. An `Error` from the limiter, such as a lost Redis connection, fails the call with an `UnexpectedError`.

### Verrou

`verrou(factory, options?)` turns a [Verrou](https://github.com/Julien-R44/verrou) instance into a lock provider, for locks shared between processes with Redis, a database, or DynamoDB:

```ts
import { Verrou } from '@verrou/core'
import { memoryStore } from '@verrou/core/drivers/memory'
import { Tenace } from '@julr/tenace'
import { verrou } from '@julr/tenace/adapters/verrou'

// use the redis store of Verrou in production
const locks = new Verrou({ default: 'memory', stores: { memory: { driver: memoryStore() } } })

const policy = Tenace.policy().withLock({
  provider: verrou(locks),
  key: 'reports',
  timeout: '5s',
  ttl: '1m',
})
```

`ttl` becomes the TTL of the Verrou lock. Without it, the Verrou default applies, 30 seconds.

The adapter retries on its own instead of using the retry settings of Verrou. While the lock is held elsewhere, it tries again every `retryDelay` (`verrou(locks, { retryDelay: '100ms' })`, 250 ms by default), until `timeout` elapses. Then the call fails with a `LockNotAcquiredError`. `timeout: 0` tries once, and without `timeout` the adapter waits as long as the signal allows. It stops waiting as soon as the signal aborts.

### BentoCache

`bentocache(cache)` turns a [BentoCache](https://github.com/Julien-R44/bentocache) instance or namespace into a cache provider:

```ts
import { BentoCache, bentostore } from 'bentocache'
import { memoryDriver } from 'bentocache/drivers/memory'
import { Tenace } from '@julr/tenace'
import { bentocache } from '@julr/tenace/adapters/bentocache'

const bento = new BentoCache({
  default: 'memory',
  stores: { memory: bentostore().useL1Layer(memoryDriver()) },
})

const policy = Tenace.policy().withCache({
  provider: bentocache(bento.namespace('users')),
  ttl: '1m',
})

await policy.execute(() => getUser(id), { key: `user:${id}` })
```

BentoCache brings multi-tier caching, grace periods, and stampede protection. Its `getOrSet` receives the `ttl` in milliseconds.

## Write your own provider

Each strategy defines a small interface: `RateLimitStore`, `LockProvider`, `CacheProvider`, and `CircuitBreakerStore`. Each strategy page shows its interface:

- [Rate limit stores](/strategies/rate-limit/#stores)
- [Lock providers](/strategies/lock/#providers)
- [Cache providers](/strategies/cache/#providers)
- [Circuit breaker stores](/strategies/circuit-breaker/#stores)
