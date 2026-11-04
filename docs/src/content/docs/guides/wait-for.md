---
title: Wait for a condition
description: Observe something until it is ready, with an interval, a deadline, and cancellation.
---

`clock.until(observe, options)` calls `observe` until it returns a value other than `undefined`, and returns that value. It returns `null` once `within` passes. Use it to wait for a service to start, a job to finish, or a queue to drain.

```ts
import { clock } from '@julr/tenace'

declare const healthUrl: string

const healthy = await clock.until(
  async signal => {
    const response = await fetch(healthUrl, { signal })
    return response.ok ? true : undefined
  },
  { within: '30s', every: '500ms' },
)

if (healthy === null) throw new Error('the service did not start within 30s')
```

## Options

| Option   | Type                                | Description                                                                                        |
| -------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `within` | `Duration`                          | How long to keep observing before giving up with `null`. `Infinity` waits until the signal aborts. |
| `every`  | `Duration \| (attempt) => Duration` | The pause between two observations, 1ms at least. See [Intervals](#intervals).                     |
| `signal` | `AbortSignal`                       | Cancels the wait.                                                                                  |

The pauses and the deadline follow the clock, so a [fake clock](/guides/testing/) drives them in tests.

## How it ends

The first observation runs right away. Each next one starts `every` after the previous one returned, and the last pause is cut to the deadline. `until` then:

- returns the value when `observe` returns something other than `undefined`, `false` and `null` included;
- returns `null` when `within` passes, even during an observation;
- rejects with `signal.reason` when the signal aborts. `observe` is not called when the signal is already aborted;
- rejects with the error of `observe` when it throws or rejects before the deadline.

`observe` receives a signal that aborts at the deadline and with the caller, so an observation still running can stop: pass it to `fetch` and friends. A value observed after the deadline or the abort is dropped.

An invalid `within` or `every` rejects with a `RangeError`.

## Intervals

`every` accepts a duration, or a function of the number of observations done so far. A backoff from `backoff` works, to observe often at first and less often later:

```ts
import { backoff, clock } from '@julr/tenace'

declare function findJob(jobId: string): Promise<{ done: boolean; output: string }>

const output = await clock.until(
  async () => {
    const job = await findJob('job-1')
    return job.done ? job.output : undefined
  },
  { within: '2m', every: backoff.exponential({ base: '100ms', max: '5s', jitter: 'none' }) },
)
```

## Treat errors as not ready

A throwing `observe` ends the wait. When an error means "not ready yet", such as a database that refuses connections while it starts, catch it and return `undefined`:

```ts
import { clock } from '@julr/tenace'

declare const db: { ping(): Promise<void> }

await clock.until(
  () =>
    db.ping().then(
      () => true,
      () => undefined,
    ),
  { within: '1m', every: '500ms' },
)
```
