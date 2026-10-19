---
title: Lock
description: Run the steps added before while holding a lock, in process or distributed.
---

A lock runs the steps added before it while holding a lock on a key. Calls with the same key run one at a time.

```ts
import { Lock, Tenace } from '@julr/tenace'

const lock = new Lock({ key: 'reports', timeout: '5s' })

const policy = Tenace.policy().withTimeout('1m').with(lock)
```

## API

```ts nocheck
policy.withLock(lock?: Lock | LockOptions)
new Lock(options?: LockOptions)
```

| Option     | Type           | Default                       | Description                                                              |
| ---------- | -------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `provider` | `LockProvider` | a shared `MemoryLockProvider` | What hands out the locks.                                                |
| `key`      | `string`       | the execution key             | The lock key. A key is required, from this option or from the execution. |
| `timeout`  | `Duration`     | as long as the signal allows  | Longest time to wait for the lock.                                       |
| `ttl`      | `Duration`     | the provider default          | Longest time the lock is held, for distributed providers.                |

When neither the lock nor the execution has a key, the execution rejects with a `TypeError`. Pass a key per call with `execute(fn, { key })`. See [Keys](/guides/keys-and-adapters/).

## Behavior

The default `MemoryLockProvider` gives one holder per key, in arrival order, within the process. Every `Lock` without a `provider` shares one `MemoryLockProvider`, so two policies that each call `.withLock({ key: 'reports' })` exclude each other. Locks are not reentrant: a call that waits for a key it already holds, such as a nested policy locking the same execution key, waits until its `timeout`, or forever without one. Give nested locks distinct keys.

A call that waits longer than `timeout` fails with `LockNotAcquiredError`. A call whose signal aborts leaves the queue, and does not run even if the lock is acquired at that moment. `provider.size` returns the number of keys a `MemoryLockProvider` holds or waits for.

The lock strategy releases the lock when the steps inside it finish. It ignores a failure to release, because a distributed lock expires on its own and the call already finished. A failure to acquire, such as an unreachable Redis, becomes an `UnexpectedError`.

## Error channel

Adds `LockNotAcquiredError`. Its `key` field holds the lock key.

## Providers

```ts nocheck
interface LockProvider {
  acquire(key: string, options: LockAcquireOptions): Promise<LockLease | undefined>
}

interface LockAcquireOptions {
  readonly signal: AbortSignal // stop waiting as soon as it aborts
  readonly timeoutMs: number | undefined // undefined: wait as long as the signal allows
  readonly ttlMs: number | undefined // undefined: the provider default
  readonly clock?: Clock
}

interface LockLease {
  release(): Promise<void> | void
}
```

`acquire()` resolves with a lease, or with `undefined` when the lock was not acquired in time. For distributed locks, use the [Verrou adapter](/guides/keys-and-adapters/#verrou).

## Events

| Event           | Fields | When                               |
| --------------- | ------ | ---------------------------------- |
| `lock.rejected` | `key`  | The lock was not acquired in time. |
