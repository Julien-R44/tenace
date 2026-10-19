---
title: Custom backends
description: Back rate limits, locks, caches, and circuit breakers with your own storage by implementing a small interface.
---

Each strategy with a shared state calls a small interface. Implement it to use a backend without an adapter, or a client you already have:

| Interface             | Methods                                          | Docs                                                          |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `RateLimitStore`      | `consume`                                        | [Rate limit stores](/strategies/rate-limit/#stores)           |
| `LockProvider`        | `acquire`, then `release` on the lease           | [Lock providers](/strategies/lock/#providers)                 |
| `CacheProvider`       | `getOrSet`                                       | [Cache providers](/strategies/cache/#providers)               |
| `CircuitBreakerStore` | `admit`, `record`, `isolate`, `release`, `state` | [Circuit breaker stores](/strategies/circuit-breaker/#stores) |

Every method may be asynchronous. A store or provider that fails is handled by the strategy: each page describes what happens to the call.

## Share a circuit breaker

No distributed circuit breaker store ships with Tenace. To share one circuit between instances, write a store that keeps the state of the breaker in your backend, and reuse the state machine of the memory store, exported as `circuitBreakerMachine`. Each update of the state must be atomic, with a transaction or a compare-and-set. See [Circuit breaker stores](/strategies/circuit-breaker/#stores).

A circuit per instance is often enough: each instance sees the failures of its own calls, and opens its circuit on its own.
