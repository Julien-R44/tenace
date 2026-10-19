---
title: Distributed locks
description: Hold a lock across instances with Redis, a database, or DynamoDB, through the Verrou adapter.
---

The default lock provider holds locks in the process. To make sure only one instance runs a job at a time, back the lock with [Verrou](https://github.com/Julien-R44/verrou), which stores the locks in Redis, Postgres, MySQL, SQLite, or DynamoDB.

```sh
npm install @verrou/core ioredis
```

```ts
import { Verrou } from '@verrou/core'
import { redisStore } from '@verrou/core/drivers/redis'
import { Tenace } from '@julr/tenace'
import { verrou } from '@julr/tenace/adapters/verrou'
import { Redis } from 'ioredis'

const locks = new Verrou({
  default: 'redis',
  stores: { redis: { driver: redisStore({ connection: new Redis() }) } },
})

const policy = Tenace.policy().withLock({
  provider: verrou(locks),
  key: 'nightly-report',
  timeout: '5s',
  ttl: '1m',
})
```

Every instance that runs this policy waits for the same `nightly-report` lock. Use `memoryStore()` of Verrou in tests.

## Behavior

`ttl` becomes the TTL of the Verrou lock: if an instance crashes while holding it, the lock expires after `ttl`. Without it, the Verrou default applies, 30 seconds. Set a `ttl` longer than the work, and a timeout inside the lock to bound the work.

The adapter retries on its own instead of using the retry settings of Verrou. While the lock is held elsewhere, it tries again every `retryDelay` (`verrou(locks, { retryDelay: '100ms' })`, 250 ms by default), until `timeout` elapses. Then the call fails with a `LockNotAcquiredError`. `timeout: 0` tries once, and without `timeout` the adapter waits as long as the signal allows. It stops waiting as soon as the signal aborts.

See [Lock](/strategies/lock/) for the other options and the events.
