---
title: Running on multiple instances
description: Which strategies keep their state in the process, and how to share rate limits, locks, caches, and circuits between instances with Redis, Postgres, or DynamoDB.
---

By default, every strategy keeps its state in the process. With several instances of your app, such as pods, workers, or serverless functions, each instance has its own rate limits, locks, and circuits. A limit of 100 calls per minute becomes 100 calls per minute and per instance.

The strategies that have a state shared between calls take a backend. Point that backend at Redis, a database, or DynamoDB, and the instances share the state.

## What can be shared

| Strategy                                        | Default           | Shared between instances                                                      |
| ----------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| [Rate limit](/strategies/rate-limit/)           | in memory         | Yes, with a store. See [Shared rate limits](/distributed/rate-limits/).       |
| [Lock](/strategies/lock/)                       | in memory         | Yes, with a provider. See [Distributed locks](/distributed/locks/).           |
| [Cache](/strategies/cache/)                     | provider required | Yes, with a provider. See [Shared cache](/distributed/cache/).                |
| [Circuit breaker](/strategies/circuit-breaker/) | in memory         | With a store you write. See [Custom backends](/distributed/custom-backends/). |
| [Bulkhead](/strategies/bulkhead/)               | in memory         | No. The limit applies per instance.                                           |
| [Dedupe](/strategies/dedupe/)                   | in memory         | No. Each instance shares its own in-flight calls.                             |
| [Stale fallback](/strategies/stale-fallback/)   | in memory         | No. Each instance serves the values it stored.                                |
| [Retry budget](/strategies/retry/#retry-budget) | in memory         | No. The budget applies per instance.                                          |
| Timeout, retry, fallback, chaos                 | no state          | Nothing to share.                                                             |

A bulkhead or a retry budget per instance is usually what you want: it protects the instance itself. Divide the limit by the number of instances when it must hold for the whole fleet.

## Backends

Tenace does not talk to Redis or a database itself. It calls a small interface, and ships adapters for three libraries that implement it on many backends:

| For         | Adapter                                              | Backends                                                                   |
| ----------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Rate limits | [`rate-limiter-flexible`](/distributed/rate-limits/) | Redis, Valkey, Memcached, Postgres, MySQL, SQLite, MongoDB, DynamoDB, etc. |
| Locks       | [Verrou](/distributed/locks/)                        | Redis, Postgres, MySQL, SQLite, DynamoDB                                   |
| Cache       | [BentoCache](/distributed/cache/)                    | Redis, Postgres, MySQL, SQLite, DynamoDB, files                            |

The adapters are structural. They describe the part of each library that Tenace calls, and they import nothing at runtime. Install the library yourself, and only the ones you use.

To use another backend, implement the interface. See [Custom backends](/distributed/custom-backends/).

## Keys are shared too

With a shared backend, the [key](/concepts/keys/) of an execution names the value in the backend. Two instances that run with the key `user:42` share one rate limit, one lock, or one cached value. Prefix the keys when several apps use the same Redis, or use the prefix option of the library.
