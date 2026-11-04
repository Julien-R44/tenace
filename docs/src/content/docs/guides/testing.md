---
title: Test your policies
description: Drive time with a fake clock, inject faults with chaos, and assert on events.
---

Policies wait for timeouts, retry delays, and open circuits. A test that waits for real time is slow and flaky. Every policy reads the time from a clock, and `clock.fake()` replaces it with a time that moves only when you tell it to.

## Control time with clock.fake()

Fake the shared `clock` exported by `@julr/tenace`. Every policy reads it, so the timeouts, the retry delays, and the circuit breakers follow the same fake time:

```ts
import { clock, Tenace } from '@julr/tenace'

using time = clock.fake()
const policy = Tenace.policy().withTimeout('1s').withRetry({ retries: 2, delay: '100ms' })

// start the execution, then move time
const done = policy.settle(() => new Promise(() => {}))
await time.runAll()

const result = await done // a TimeoutError, after three attempts
```

`using` restores the system time at the end of the scope. Without it, call `clock.restore()`.

`clock.fake(at?)` freezes the calendar time at `at`, a `Date` or a `Temporal.Instant`, or at the current time. It returns a `FakeClock`:

| Member                | Description                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `advanceBy(duration)` | Moves time forward by a finite duration and fires the due timers in order. Returns a promise.                               |
| `runAll(limit?)`      | Fires every timer, including the timers they schedule, until none is left. Rejects after `limit` timers, 10,000 by default. |
| `setTime(at)`         | Moves the calendar time only, as a system clock adjustment does. No timer fires.                                            |
| `letTimePass()`       | From now on, each wait ends at once. Use it when the code under test does real I/O between two waits.                       |
| `nextWait()`          | Resolves when the next wait starts.                                                                                         |
| `pendingTimers`       | The number of waits and deadlines waiting to fire.                                                                          |
| `pendingDeadlines`    | The number of deadlines that neither ended nor were disposed.                                                               |

`advanceBy()` lets pending promise callbacks run between timers, so a timer scheduled after another one fires within the same call. It also lets a retry without delay go on after it yields to the event loop, every 100 retries. Always `await` it. It takes a number of milliseconds or a string such as `'30s'`, and rejects with a `RangeError` for a negative, `NaN`, or infinite duration. A timer of `Infinity` never fires, not even with `runAll()`.

### Give a test its own clock

Faking the shared clock fakes it for the whole process. To keep a test apart, for example when tests run concurrently, create a `Clock` and pass it to the execution:

```ts
import { CircuitBreaker, Clock, Tenace } from '@julr/tenace'

const clock = new Clock()
using time = clock.fake()
const breaker = new CircuitBreaker({ trip: { consecutive: 2 }, openFor: '30s', clock })
const policy = Tenace.policy().with(breaker)

const failing = () => Promise.reject(new Error('down'))
await policy.settle(failing, { clock })
await policy.settle(failing, { clock })
console.log(breaker.state) // 'open'

await time.advanceBy('30s')
console.log(breaker.state) // 'half-open'
```

The `clock` option of `execute()`, `settle()`, and batches reaches timeouts, retry delays, bulkhead and lock waits, chaos latency, rate limits, retry budgets, and the ages of a stale fallback. `RateLimit` and `RetryBudget` accept their own `clock` option, which takes precedence. A `CircuitBreaker` reads the time from its own `clock` option only, because its circuit is shared by every execution.

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
