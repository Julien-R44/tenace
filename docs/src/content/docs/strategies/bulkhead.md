---
title: Bulkhead
description: Limit the calls running at the same time, with an optional queue.
---

A bulkhead limits the calls running at the same time. It protects a dependency from too many concurrent calls, and protects your process from piling up work on a slow dependency.

```ts
import { Bulkhead, Tenace } from '@julr/tenace'

const bulkhead = new Bulkhead({ concurrency: 10, queue: 100, maxWait: '1s' })

const policy = Tenace.policy().withTimeout('2s').with(bulkhead)
```

Share the instance to share the limit between policies.

## API

```ts nocheck
policy.withBulkhead(bulkhead: Bulkhead | BulkheadOptions)
new Bulkhead(options: BulkheadOptions)
```

| Option        | Type       | Default      | Description                                                             |
| ------------- | ---------- | ------------ | ----------------------------------------------------------------------- |
| `concurrency` | `number`   | required     | Calls running at the same time. An integer of 1 or more, or `Infinity`. |
| `queue`       | `number`   | `0`          | Calls waiting for a slot. An integer of 0 or more, or `Infinity`.       |
| `maxWait`     | `Duration` | no limit     | Longest time a call waits in the queue before it is rejected.           |
| `name`        | `string`   | `'bulkhead'` | Name in events and in `describe()`.                                     |

An invalid `concurrency` or `queue` throws a `RangeError` when the bulkhead is built.

A `Bulkhead` instance exposes `concurrency`, `running` (the calls running now), and `queued` (the calls waiting now).

## Behavior

When a slot is free, the call runs. When every slot is busy, the call waits in the queue if there is room, and fails with `BulkheadFullError` otherwise. With the default `queue: 0`, a call fails as soon as every slot is busy.

Queued calls run in arrival order. A queued call fails with `BulkheadFullError` when it waits longer than `maxWait`, and leaves the queue when its signal aborts. A call whose signal aborts at the moment it gets its slot does not run.

## Error channel

Adds `BulkheadFullError`. Its `running` and `queued` fields hold the counts when the call was rejected.

## Events

| Event               | Fields                          | When                |
| ------------------- | ------------------------------- | ------------------- |
| `bulkhead.rejected` | `bulkhead`, `running`, `queued` | A call is rejected. |
