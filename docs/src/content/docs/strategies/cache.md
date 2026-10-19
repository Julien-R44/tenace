---
title: Cache
description: Serve the steps added before from a cache. Only successes are cached, and a failing cache is skipped.
---

A cache serves the steps added before it from a cache provider. A hit returns the cached value without running them. A miss runs them and stores the value.

```ts
import { Tenace } from '@julr/tenace'
import { bentocache } from '@julr/tenace/adapters/bentocache'
import { BentoCache, bentostore } from 'bentocache'
import { memoryDriver } from 'bentocache/drivers/memory'

const bento = new BentoCache({
  default: 'memory',
  stores: { memory: bentostore().useL1Layer(memoryDriver()) },
})

const users = Tenace.policy()
  .withTimeout('1s')
  .withCache({ provider: bentocache(bento), ttl: '1m' })

await users.execute(() => getUser(id), { key: `user:${id}` })
```

Tenace does not implement a cache. It calls a provider: the [BentoCache adapter](/distributed/cache/), or a few lines around your own cache.

## API

```ts nocheck
policy.withCache(cache: Cache | CacheOptions)
new Cache(options: CacheOptions)
```

| Option     | Type            | Default              | Description                                                               |
| ---------- | --------------- | -------------------- | ------------------------------------------------------------------------- |
| `provider` | `CacheProvider` | required             | The cache.                                                                |
| `key`      | `string`        | the execution key    | The cache key. A key is required, from this option or from the execution. |
| `ttl`      | `Duration`      | the provider default | How long a value stays cached.                                            |

When neither the cache nor the execution has a key, the execution rejects with a `TypeError`.

## Behavior

Only successes are cached. A failure of the steps inside reaches the caller, and the provider stores nothing. When the provider serves a stale value for the failure instead, such as during a BentoCache grace period, the cache returns that value and emits `cache.stale`.

A failing cache does not fail the call, and the steps inside never run twice. When the provider throws before the steps inside started, they run without the cache. When the provider throws after they started, the cache waits for them and returns their result. Both cases emit `cache.failed`.

## Providers

```ts nocheck
interface CacheProvider {
  getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    options: { readonly ttlMs: number | undefined },
  ): Promise<T>
}
```

`getOrSet()` returns the cached value, or calls `factory`, stores its value, and returns it. When `factory` rejects, the provider must store nothing, and either reject or return a stale value. A provider around a `Map`:

```ts
import { type CacheProvider, Tenace } from '@julr/tenace'

const values = new Map<string, unknown>()

const mapCache: CacheProvider = {
  async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
    if (values.has(key)) return values.get(key) as T
    const value = await factory()
    values.set(key, value)
    return value
  },
}

const policy = Tenace.policy().withCache({ provider: mapCache })
```

This provider ignores `ttlMs`, so values never expire.

## Error channel

Unchanged.

## Events

| Event          | Fields         | When                                                           |
| -------------- | -------------- | -------------------------------------------------------------- |
| `cache.hit`    | `key`          | The value came from the cache.                                 |
| `cache.miss`   | `key`          | The steps inside ran and the value was stored.                 |
| `cache.stale`  | `key`, `error` | The steps inside failed and the provider served a stale value. |
| `cache.failed` | `key`, `error` | The provider failed.                                           |
