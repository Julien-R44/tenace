---
title: Signals and cancellation
description: The context your function receives, what aborts its signal, and what happens when the caller aborts.
---

Your function receives a context with two fields:

- `signal`, an `AbortSignal` that aborts when the work should stop.
- `attempt`, the 1-based attempt number. A retry increments it.

```ts
import { Tenace } from '@julr/tenace'

const response = await Tenace.policy()
  .withTimeout('1s')
  .withRetry({ retries: 2 })
  .execute(({ signal, attempt }) => {
    console.log(`attempt ${attempt}`)
    return fetch('https://example.com/users', { signal })
  })
```

Pass the signal to everything that accepts one: `fetch`, database drivers, child processes. A timeout cannot stop work that ignores its signal. It can only stop waiting for it.

## What aborts the signal

- **A timeout.** At the deadline, the timeout aborts the signal of the steps inside it. The abort reason is the `TimeoutError`.
- **The caller.** Pass `signal` to `execute()` or `settle()`. Aborting it aborts the signal of the function with the same reason.
- **A failed batch sibling.** In a fail-fast batch, the first failure aborts the signal of the tasks still running. See [Batches](/guides/batches/).
- **Every caller of a deduplicated run leaving.** The shared run of a dedupe aborts when its last caller aborts. See [Dedupe](/strategies/dedupe/).

## When the caller aborts

A caller abort stops the execution right away. `execute()` and `settle()` both reject with `signal.reason`, even if the function ignores its signal. The abort reason is not part of the error channel, the same way an aborted `fetch` rejects with an `AbortError` rather than returning a value.

```ts
import { Tenace } from '@julr/tenace'

const controller = new AbortController()
setTimeout(() => controller.abort(new Error('user left')), 100)

try {
  await Tenace.policy()
    .withRetry({ retries: 5 })
    .settle(({ signal }) => fetch('https://example.com/report', { signal }), {
      signal: controller.signal,
    })
} catch (error) {
  console.log(error) // Error: user left
}
```

If the signal is already aborted, the policy rejects without calling the function.

The strategies react to the abort too:

- A retry stops waiting and does not start another attempt.
- A fallback does not run.
- A circuit breaker does not count the aborted call as a failure or a success.
- A call waiting in a bulkhead queue, a lock queue, or a rate limit leaves it, and does not run even if it gets its slot or its lock at that moment.
