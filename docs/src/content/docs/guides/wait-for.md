---
title: Wait for a condition
description: Poll a condition until it is true, with an interval, a timeout, and cancellation.
---

`waitFor(condition, options)` calls `condition` until it returns `true`, then resolves. Use it to wait for a service to start, a job to finish, or a queue to drain.

```ts
import { waitFor } from '@julr/tenace'

declare const healthUrl: string

await waitFor(
  async ({ signal }) => {
    const response = await fetch(healthUrl, { signal })
    return response.ok
  },
  { interval: '500ms', timeout: '30s' },
)
```

`Tenace.waitFor` is the same function.

## Options

| Option     | Type                                | Default        | Description                                                                   |
| ---------- | ----------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `interval` | `Duration \| (attempt) => Duration` | `100ms`        | Delay between two checks, 1ms at least. See [Intervals](#intervals).          |
| `timeout`  | `Duration`                          | `10s`          | Longest wait, from the call. `Infinity` waits until the signal aborts.        |
| `signal`   | `AbortSignal`                       |                | Stops waiting.                                                                |
| `clock`    | `Clock`                             | the system one | Clock of the delays and the timeout, such as a [TestClock](/guides/testing/). |

## How it ends

The first check runs right away. Each next check starts `interval` after the previous one returned. `waitFor` then:

- resolves when `condition` returns `true`;
- rejects with a [`TimeoutError`](/reference/errors/) when the timeout elapses, even during a check;
- rejects with `signal.reason` when the signal aborts. `condition` is not called when the signal is already aborted;
- rejects with the error of `condition` when it throws or rejects;
- rejects with a `TypeError` when `condition` returns something other than a boolean.

`condition` receives a [context](/concepts/cancellation/) with a `signal` and the 1-based `attempt` of the check. The signal aborts when the wait ends, so a check still running when the timeout fires can stop: pass the signal to `fetch` and friends.

An invalid `interval` or `timeout` rejects with a `RangeError`.

## Intervals

`interval` accepts a duration, or a function of the number of checks done so far. A backoff from `backoff` works, to check often at first and less often later:

```ts
import { backoff, waitFor } from '@julr/tenace'

declare function isJobDone(jobId: string): Promise<boolean>

await waitFor(() => isJobDone('job-1'), {
  interval: backoff.exponential({ base: '100ms', max: '5s', jitter: 'none' }),
  timeout: '2m',
})
```

## Treat errors as not ready

A throwing `condition` ends the wait. When an error means "not ready yet", such as a database that refuses connections while it starts, catch it and return `false`:

```ts
import { waitFor } from '@julr/tenace'

declare const db: { ping(): Promise<void> }

await waitFor(
  () =>
    db.ping().then(
      () => true,
      () => false,
    ),
  { interval: '500ms', timeout: '1m' },
)
```
