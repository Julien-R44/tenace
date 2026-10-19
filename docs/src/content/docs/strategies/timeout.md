---
title: Timeout
description: Bound the time spent in the steps added before, per attempt or in total.
---

A timeout bounds the time spent in the steps added before it. At the deadline, it aborts their signal and fails with `TimeoutError`.

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('500ms')
```

Inside a retry, a timeout bounds each attempt. Outside a retry, it bounds the total. See [Strategy order](/concepts/strategy-order/).

## API

```ts nocheck
policy.withTimeout(duration: Duration, options?: TimeoutOptions)
new Timeout(duration: Duration, options?: TimeoutOptions)
```

| Option | Type                            | Default        | Description                                        |
| ------ | ------------------------------- | -------------- | -------------------------------------------------- |
| `mode` | `'aggressive' \| 'cooperative'` | `'aggressive'` | What happens at the deadline. See [Modes](#modes). |

`duration` is a number of milliseconds or a string such as `'500ms'`, `'1.5s'`, or `'2m'`. `Infinity` disables the timeout. A negative or malformed duration, or an unknown `mode`, throws a `RangeError` when the policy is built.

A `Timeout` instance exposes `timeoutMs` and `mode`.

## Modes

**`aggressive`** (default). At the deadline, the timeout aborts the signal and fails with `TimeoutError` right away, even if the function ignores the signal. The work of a function that ignores its signal keeps running in the background, and its result is dropped. If that work later hits a defect, such as a throwing callback, the defect is reported with `globalThis.reportError`, or as an uncaught error where it is missing, as on Node.js. An aggressive timeout also stops waiting as soon as the caller aborts.

**`cooperative`**. At the deadline, the timeout aborts the signal, then waits for the function to settle. A failure after the deadline becomes `TimeoutError`. A success after the deadline is kept.

```ts
import { Tenace } from '@julr/tenace'

// waits for the query to stop, so the connection is free when the policy returns
const policy = Tenace.policy().withTimeout('2s', { mode: 'cooperative' })
```

Use `cooperative` when the function cleans up after an abort and the caller must not continue before the cleanup ends.

## Error channel

Adds `TimeoutError`. Its `timeoutMs` field holds the duration. The signal aborts with the same `TimeoutError` as reason.

## Events

| Event     | Fields                 | When                                  |
| --------- | ---------------------- | ------------------------------------- |
| `timeout` | `attempt`, `timeoutMs` | The timeout returns a `TimeoutError`. |
