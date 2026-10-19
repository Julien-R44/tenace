---
title: Dedupe
description: Concurrent executions with the same key share one run.
---

Dedupe makes concurrent executions with the same key share one run of the steps added before it. The first execution runs, and the executions that arrive while it runs wait for its result. This pattern is also known as single-flight.

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s').withDedupe()

// one call to getUser, two results
const [a, b] = await Promise.all([
  policy.execute(() => getUser('1'), { key: 'user:1' }),
  policy.execute(() => getUser('1'), { key: 'user:1' }),
])
```

Once the shared run settles, the next execution with that key runs again. Dedupe does not cache. Combine it with a [cache](/strategies/cache/) for that.

## API

```ts nocheck
policy.withDedupe(dedupe?: Dedupe | DedupeOptions)
new Dedupe(options?: DedupeOptions)
```

| Option | Type     | Default           | Description                                                                                 |
| ------ | -------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `key`  | `string` | the execution key | Key identifying identical calls. A key is required, from this option or from the execution. |

When neither the dedupe nor the execution has a key, the execution rejects with a `TypeError`. See [Keys](/concepts/keys/).

A `Dedupe` instance exposes `pending`, the number of keys running now.

## Behavior

The shared run gets its own signal. A caller that aborts stops waiting, and the run continues for the others. The run aborts when every caller has aborted.

Every caller receives the same `Result`. The shared run uses the context of the first caller: its attempt number, its clock, and its instrumentation.

## Error channel

Unchanged.

## Events

| Event           | Fields | When                                              |
| --------------- | ------ | ------------------------------------------------- |
| `dedupe.joined` | `key`  | An execution joins a run that is already running. |
