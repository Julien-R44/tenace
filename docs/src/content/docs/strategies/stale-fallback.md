---
title: Stale fallback
description: Serve the last successful value of a key when the steps added before fail.
---

A stale fallback remembers the last successful value of each key. When the steps added before it fail, it returns that value instead of the error. This pattern is also known as stale-if-error.

```ts
import { Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('1s').withStaleFallback({ maxAge: '1h' })

await policy.execute(() => getUser(id), { key: `user:${id}` })
```

## API

```ts nocheck
policy.withStaleFallback(stale?: StaleFallback | StaleFallbackOptions)
new StaleFallback(options?: StaleFallbackOptions)
```

| Option       | Type       | Default           | Description                                                                                     |
| ------------ | ---------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `maxAge`     | `Duration` | no limit          | Oldest value that may be served.                                                                |
| `maxEntries` | `number`   | `1000`            | Keys remembered. The least recently written key is forgotten first.                             |
| `key`        | `string`   | the execution key | The key values are remembered under. A key is required, from this option or from the execution. |

## Behavior

When neither the stale fallback nor the execution has a key, the execution rejects with a `TypeError`.

Each success stores its value under the key, with the time on the execution clock. A failure returns the stored value when there is one and it is at most `maxAge` old. Otherwise the failure goes through. A stale fallback does not serve a value when the signal is aborted.

The values live in the `StaleFallback` instance, in memory. Share the instance to share the values between policies.

## Error channel

Unchanged. A failure with no stored value still fails, so the errors stay in the channel.

## Events

| Event            | Fields         | When                              |
| ---------------- | -------------- | --------------------------------- |
| `fallback.stale` | `key`, `ageMs` | A stored value replaces an error. |
