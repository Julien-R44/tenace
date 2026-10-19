---
title: Composition and shared instances
description: How .with() combines strategies and policies, and how stateful strategies share their state.
---

`.with(x)` is the one composition operator. `x` is a strategy instance or another reusable policy. Every `withX()` method is a shortcut for `.with(new X(...))`.

```ts
import { Retry, Tenace, Timeout } from '@julr/tenace'

// these two policies are the same
const a = Tenace.policy().withTimeout('1s').withRetry({ retries: 2 })
const b = Tenace.policy()
  .with(new Timeout('1s'))
  .with(new Retry({ retries: 2 }))
```

## Policies are immutable

Every method returns a new policy and leaves the original untouched. You can build a base policy and derive variants from it:

```ts
import { Tenace } from '@julr/tenace'

const base = Tenace.policy().withTimeout('1s')
const withRetries = base.withRetry({ retries: 3 })
const withFallback = base.withFallback(() => null)

base.describe() // ['timeout']
withRetries.describe() // ['retry', 'timeout']
```

## Strategies are shared by identity

A policy holds references to its strategy instances. Adding the same instance to two policies shares its state between them. For a circuit breaker, both policies see the same circuit, so failures through one policy can open it for the other.

```ts
import { CircuitBreaker, Tenace } from '@julr/tenace'

const breaker = new CircuitBreaker({ trip: { consecutive: 5 }, openFor: '30s' })

const charge = Tenace.policy().withTimeout('2s').with(breaker)
const refund = Tenace.policy().withTimeout('5s').with(breaker) // same circuit
```

The stateful strategies are `CircuitBreaker`, `Bulkhead`, `RateLimit`, `Lock`, `Dedupe`, and `StaleFallback`. A `RetryBudget` passed to several retries is shared the same way.

A `withX(options)` call creates a new instance. Two policies built with their own `.withCircuitBreaker({ ... })` calls have two separate circuits. Derived policies are different: `base.withRetry(...)` copies the strategy references of `base`, so every policy derived from `base` shares its breaker.

The methods also accept an instance, so `.withCircuitBreaker(breaker)` and `.with(breaker)` are the same. Instances and policies created by a duplicated copy of the package are recognized too.

## Inline a policy into another

`.with(policy)` inlines every strategy of `policy` at that position, with its errors and its fallback values. Use it to build one policy per dependency and reuse it in the policies of each operation:

```ts
import { Bulkhead, CircuitBreaker, Tenace } from '@julr/tenace'

const breaker = new CircuitBreaker({ name: 'payments-api' })
const bulkhead = new Bulkhead({ name: 'payments-api', concurrency: 10, queue: 50 })

// every policy that inlines paymentsApi shares the circuit and the slots
const paymentsApi = Tenace.policy().withTimeout('2s').with(breaker).with(bulkhead)

const charge = Tenace.policy()
  .with(paymentsApi)
  .withFallbackOn(['CircuitOpenError'], () => 'queued')

const refund = Tenace.policy().with(paymentsApi).withRetry({ retries: 2 })

charge.describe() // ['fallback', 'payments-api', 'payments-api', 'timeout']
```

The inlined policy contributes its strategies only. The `name` and `instrumentation` options of the outer policy apply. A policy bound with `Tenace.call(fn)` cannot be inlined.
