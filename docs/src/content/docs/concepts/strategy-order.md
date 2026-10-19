---
title: Strategy order
description: Why the first strategy you add is the innermost one, and where to place each strategy.
---

A policy is a stack of strategies around your function. The first strategy you add is the innermost one, the closest to the function. Each method wraps the steps added before it.

```ts
import { Tenace } from '@julr/tenace'

// the timeout bounds each attempt: up to 4 attempts of 1s each
const perAttempt = Tenace.policy().withTimeout('1s').withRetry({ retries: 3 })

// the timeout bounds the whole execution: every attempt and delay share 5s
const total = Tenace.policy().withRetry({ retries: 3 }).withTimeout('5s')
```

`policy.describe()` returns the strategy names from the outermost to the innermost, the order in which a call goes through them:

```ts
import { Tenace } from '@julr/tenace'

Tenace.policy().withTimeout('1s').withRetry({ retries: 3 }).describe() // ['retry', 'timeout']
```

## Why the first strategy is the innermost

A chain reads in the order the error travels. The function fails, the timeout sees the failure first, then the retry, then the fallback. Writing `.withTimeout().withRetry().withFallback()` lists the strategies in that order.

The types follow the same rule. A callback sees the errors of the steps added before it, and nothing else. `.withFallbackOn(['TimeoutError'], ...)` compiles after `.withTimeout()`, and TypeScript rejects it before, because no `TimeoutError` can reach it yet:

```ts nocheck
Tenace.policy()
  .withTimeout('1s')
  .withFallbackOn(['TimeoutError'], () => null) // compiles
Tenace.policy()
  .withFallbackOn(['TimeoutError'], () => null)
  .withTimeout('1s') // type error
```

## Where to place each strategy

Most placement questions come down to what the outer strategy should see: every attempt, or the final outcome.

**Timeout.** Inside a retry, it bounds each attempt. Outside a retry, it bounds the whole execution, delays included. When the outer timeout fires, it aborts the signal and the retry stops. Use both when you need both limits.

**Circuit breaker.** Inside a retry, the breaker records every attempt, so one execution with three failed attempts counts as three failures. Outside a retry, it records only the final outcome. Once the circuit is open, a retry outside the breaker receives `CircuitOpenError`, whose `retryAfterMs` makes the retry wait until the circuit admits calls again. With the default `openFor` of 30 seconds, that wait can be longer than you want. Exclude `CircuitOpenError` with `retryOn`, or set `respectRetryAfter: false`.

**Bulkhead.** Outside a retry, one execution holds one slot for all its attempts and delays. Inside a retry, each attempt takes a slot and gives it back during the delay.

**Lock.** Outside a retry, the lock is held during every attempt and delay. Inside a retry, each attempt acquires the lock again.

**Fallback.** Last, it handles every error of the chain. A fallback inside a retry turns failures into values, so the retry sees a success and never retries.

**Cache.** A cache outside a fallback stores the fallback values too. A cache inside a fallback stores only real values. A rate limit inside a cache consumes nothing on a cache hit, because a hit never reaches it.

A common layout for a call to a remote dependency:

```ts
import { Bulkhead, CircuitBreaker, Tenace } from '@julr/tenace'

const breaker = new CircuitBreaker({ trip: { consecutive: 5 }, openFor: '30s' })
const bulkhead = new Bulkhead({ concurrency: 10 })

const policy = Tenace.policy()
  .withTimeout('1s') // each attempt
  .with(breaker) // records each attempt
  .withRetry({ retries: 2, retryOn: ['TimeoutError'] })
  .with(bulkhead) // one slot per execution
  .withFallbackOn(['CircuitOpenError', 'BulkheadFullError'], () => null)
```
