---
title: Test your policies
description: Drive time with TestClock, inject faults with chaos, and assert on events.
---

Policies wait for timeouts, retry delays, and open circuits. A test that waits for real time is slow and flaky. Tenace lets you replace the clock with a `TestClock` that moves only when you tell it to.

## Control time with TestClock

Import `TestClock` from `@julr/tenace/testing` and pass it to the execution:

```ts
import { Tenace } from '@julr/tenace'
import { TestClock } from '@julr/tenace/testing'

const clock = new TestClock()
const policy = Tenace.policy().withTimeout('1s').withRetry({ retries: 2, delay: '100ms' })

// start the execution, then move time
const done = policy.settle(() => new Promise(() => {}), { clock })
await clock.runAll()

const result = await done // a TimeoutError, after three attempts
```

`TestClock` has these methods:

| Member                    | Description                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `new TestClock(startAt?)` | Starts at `startAt` milliseconds since the epoch, 0 by default.                                                             |
| `now()`                   | The current time of the clock.                                                                                              |
| `advance(duration)`       | Moves time forward by a finite duration and fires the due timers in order. Returns a promise.                               |
| `runAll(limit?)`          | Fires every timer, including the timers they schedule, until none is left. Rejects after `limit` timers, 10,000 by default. |
| `pendingTimers`           | The number of timers waiting to fire.                                                                                       |

`advance()` lets pending promise callbacks run between timers, so a timer scheduled after another one fires within the same call. It also lets a retry without delay go on after it yields to the event loop, every 100 retries. Always `await` it. It takes a number of milliseconds or a string such as `'30s'`, and rejects with a `RangeError` for a negative, `NaN`, or infinite duration. A timer of `Infinity` never fires, not even with `runAll()`.

### Which strategies follow the execution clock

The `clock` option of `execute()`, `settle()`, and batches reaches timeouts, retry delays, bulkhead and lock waits, chaos latency, rate limits, retry budgets, and the ages of a stale fallback. `RateLimit` and `RetryBudget` accept their own `clock` option, which takes precedence.

A `CircuitBreaker` reads the time from its own `clock` option only, because its circuit is shared by every execution. Pass it the same clock:

```ts
import { CircuitBreaker, Tenace } from '@julr/tenace'
import { TestClock } from '@julr/tenace/testing'

const clock = new TestClock()
const breaker = new CircuitBreaker({ trip: { consecutive: 2 }, openFor: '30s', clock })
const policy = Tenace.policy().with(breaker)

const failing = () => Promise.reject(new Error('down'))
await policy.settle(failing, { clock })
await policy.settle(failing, { clock })
console.log(breaker.state) // 'open'

await clock.advance(30_000)
console.log(breaker.state) // 'half-open'
```

## Make randomness predictable

Backoff jitter and chaos draw random numbers. Both accept a `random` function that replaces `Math.random`:

```ts
import { backoff, Tenace } from '@julr/tenace'

const policy = Tenace.policy().withRetry({
  retries: 3,
  delay: backoff.exponential({ random: () => 1 }), // full jitter, always the full delay
})
```

## Inject faults

`withChaos()` injects faults into one policy. In a test, it shows how the rest of the policy reacts:

```ts
import { Tenace } from '@julr/tenace'

// the latency makes the timeout fire, and the fallback answers
const policy = Tenace.policy()
  .withChaos({ latency: '2s' })
  .withTimeout('1s')
  .withFallbackOn(['TimeoutError'], () => 'cached')
```

`Tenace.chaos()` injects faults around the function of every policy, without changing the code under test. Restore the previous setting after each test:

```ts
import { Tenace } from '@julr/tenace'

const restore = Tenace.chaos({ throws: () => new Error('users API down') })
try {
  // run the code under test: every function called through a policy now throws
} finally {
  restore()
}
```

See [Chaos](/strategies/chaos/) for every option.

## Assert on events

`listener()` builds an instrumentation that receives the events of each execution. Record them to check what the policy did:

```ts
import { listener, Tenace, type TenaceEvent } from '@julr/tenace'

const events: TenaceEvent[] = []
const policy = Tenace.policy({ instrumentation: listener(event => events.push(event)) }).withRetry({
  retries: 1,
  delay: 0,
})

await policy.settle(() => Promise.reject(new Error('down')))

console.log(events.map(event => event.type)) // ['retry.scheduled', 'retry.exhausted']
```
