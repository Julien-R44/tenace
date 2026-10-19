---
title: Events
description: Every event the strategies report to the instrumentation.
---

Strategies report events to the [instrumentation](/observability/instrumentation/) of the execution. Every event has a `type`. `attempt` is 1-based.

| `type`                  | Fields                                                                 | Reported by                                     |
| ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| `retry.scheduled`       | `attempt`, `delayMs`, `error`                                          | [Retry](/strategies/retry/)                     |
| `retry.exhausted`       | `attempts`, `error`                                                    | [Retry](/strategies/retry/)                     |
| `retry.declined`        | `attempt`, `error`, `reason`: `'budget'`, `'idempotency'` or `'delay'` | [Retry](/strategies/retry/)                     |
| `timeout`               | `attempt`, `timeoutMs`                                                 | [Timeout](/strategies/timeout/)                 |
| `circuit.state_changed` | `breaker`, `from`, `to`                                                | [Circuit breaker](/strategies/circuit-breaker/) |
| `circuit.rejected`      | `breaker`, `state`, `retryAfterMs`                                     | [Circuit breaker](/strategies/circuit-breaker/) |
| `bulkhead.rejected`     | `bulkhead`, `running`, `queued`                                        | [Bulkhead](/strategies/bulkhead/)               |
| `fallback.used`         | `error`                                                                | [Fallback](/strategies/fallback/)               |
| `fallback.stale`        | `key`, `ageMs`                                                         | [Stale fallback](/strategies/stale-fallback/)   |
| `rate_limit.rejected`   | `key`, `retryAfterMs`                                                  | [Rate limit](/strategies/rate-limit/)           |
| `lock.rejected`         | `key`                                                                  | [Lock](/strategies/lock/)                       |
| `dedupe.joined`         | `key`                                                                  | [Dedupe](/strategies/dedupe/)                   |
| `cache.hit`             | `key`                                                                  | [Cache](/strategies/cache/)                     |
| `cache.miss`            | `key`                                                                  | [Cache](/strategies/cache/)                     |
| `cache.stale`           | `key`, `error`                                                         | [Cache](/strategies/cache/)                     |
| `cache.failed`          | `key`, `error`                                                         | [Cache](/strategies/cache/)                     |
| `custom`                | `name`, `attributes?`                                                  | [Custom strategies](/guides/custom-strategies/) |

The union of these shapes is the `TenaceEvent` type. A `switch` on `event.type` narrows it:

```ts
import { listener, type TenaceEvent } from '@julr/tenace'

function describeEvent(event: TenaceEvent): string {
  switch (event.type) {
    case 'retry.scheduled':
      return `retry ${event.attempt} in ${event.delayMs}ms`
    case 'circuit.state_changed':
      return `${event.breaker}: ${event.from} -> ${event.to}`
    default:
      return event.type
  }
}

const instrumentation = listener(event => logger.info(describeEvent(event)))
```
