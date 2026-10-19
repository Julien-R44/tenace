---
title: Shared cache
description: Share cached values between instances with Redis or a database, through the BentoCache adapter.
---

The cache strategy calls a provider. To share the cached values between instances, use [BentoCache](https://github.com/Julien-R44/bentocache), a multi-tier cache: an in-memory layer in each instance, a shared layer in Redis, a database, DynamoDB, or files, and a bus that keeps the memory layers in sync.

```sh
npm install bentocache ioredis
```

```ts
import { BentoCache, bentostore } from 'bentocache'
import { memoryDriver } from 'bentocache/drivers/memory'
import { redisBusDriver, redisDriver } from 'bentocache/drivers/redis'
import { Tenace } from '@julr/tenace'
import { bentocache } from '@julr/tenace/adapters/bentocache'
import { Redis } from 'ioredis'

const bento = new BentoCache({
  default: 'cache',
  stores: {
    cache: bentostore()
      .useL1Layer(memoryDriver({ maxSize: '10mb' }))
      .useL2Layer(redisDriver({ connection: new Redis() }))
      .useBus(redisBusDriver({ connection: { host: '127.0.0.1', port: 6379 } })),
  },
})

const policy = Tenace.policy().withCache({
  provider: bentocache(bento.namespace('users')),
  ttl: '1m',
})

await policy.execute(() => getUser(id), { key: `user:${id}` })
```

`bentocache(cache)` takes a BentoCache instance or a namespace. A namespace prefixes the keys, so two policies never read the values of each other.

## Behavior

The `ttl` of the strategy is passed to `getOrSet` of BentoCache, in milliseconds. BentoCache also brings grace periods and stampede protection: when a refresh fails during a grace period, BentoCache returns the stale value, and the cache strategy emits `cache.stale`.

See [Cache](/strategies/cache/) for the other options and the events.
