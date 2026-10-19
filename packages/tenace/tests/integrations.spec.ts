import { test } from '@japa/runner'

import { ExecutionContext } from '../src/context.ts'
import { LockNotAcquiredError, RateLimitError, UnexpectedError } from '../src/errors.ts'
import { listener, type TenaceEvent } from '../src/instrumentation.ts'
import { err, ok } from '../src/result.ts'
import type { CacheProvider } from '../src/strategies/cache.ts'
import { Dedupe } from '../src/strategies/dedupe.ts'
import { Lock, type LockProvider, MemoryLockProvider } from '../src/strategies/lock.ts'
import { MemoryRateLimitStore, RateLimit } from '../src/strategies/rate_limit.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => (resolve = res))
  return { promise, resolve }
}

function recorder() {
  const events: TenaceEvent[] = []
  return {
    events,
    instrumentation: listener(event => events.push(event)),
    types: () => events.map(e => e.type),
  }
}

test.group('RateLimit', () => {
  test('allows `limit` calls per window, then rejects with retryAfterMs', async ({ assert }) => {
    const clock = new TestClock()
    const policy = Tenace.policy().withRateLimit({ limit: 2, per: '1s', clock })
    assert.deepEqual(await policy.settle(() => 1), ok(1))
    assert.deepEqual(await policy.settle(() => 2), ok(2))

    const rejected = await policy.settle(() => 3)
    assert.isTrue(!rejected.ok && rejected.error instanceof RateLimitError)
    assert.equal((rejected as { error: RateLimitError }).error.retryAfterMs, 500)

    await clock.advance(500)
    assert.deepEqual(await policy.settle(() => 4), ok(4))
  })

  test('counts each key separately', async ({ assert }) => {
    const policy = Tenace.policy().withRateLimit({ limit: 1, per: '1m', clock: new TestClock() })
    assert.isTrue((await policy.settle(() => 1, { key: 'a' })).ok)
    assert.isTrue((await policy.settle(() => 1, { key: 'b' })).ok)
    assert.isFalse((await policy.settle(() => 1, { key: 'a' })).ok)
  })

  test('maxWait waits for a slot instead of rejecting', async ({ assert }) => {
    const clock = new TestClock()
    const policy = Tenace.policy().withRateLimit({ limit: 1, per: 100, maxWait: 150, clock })
    await policy.settle(() => 1, { clock })
    const waiting = policy.settle(() => clock.now(), { clock })
    await clock.advance(100)
    assert.deepEqual(await waiting, ok(100))
  })

  test('waits on its own clock when it has one', async ({ assert }) => {
    const clock = new TestClock()
    const policy = Tenace.policy().withRateLimit({ limit: 1, per: '1m', maxWait: '2m', clock })
    await policy.settle(() => 1)
    const waiting = policy.settle(() => clock.now())
    await clock.advance('1m')
    const late = new Promise(resolve => setTimeout(resolve, 50, 'still waiting'))
    assert.deepEqual(await Promise.race([waiting, late]), ok(60_000))
  })

  test('an outer retry waits retryAfterMs', async ({ assert }) => {
    const clock = new TestClock()
    const policy = Tenace.policy()
      .withRateLimit({ limit: 1, per: '1s', clock })
      .withRetry({ retries: 1, delay: 0 })
    await policy.settle(() => 'first', { clock })
    const retried = policy.settle(() => clock.now(), { clock })
    await clock.advance(1000)
    assert.deepEqual(await retried, ok(1000))
  })

  test('a shared store limits every policy using it', async ({ assert }) => {
    const store = new MemoryRateLimitStore({ limit: 1, per: '1m' })
    await Tenace.policy()
      .with(new RateLimit({ store }))
      .settle(() => 1)
    const other = await Tenace.policy()
      .withRateLimit({ store })
      .settle(() => 1)
    assert.isFalse(other.ok)
  })

  test('waiting retryAfterMs is always enough', ({ assert }) => {
    const failures: string[] = []
    for (let limit = 1; limit <= 30; limit++) {
      for (let per = 1; per <= 3000; per += 7) {
        const store = new MemoryRateLimitStore({ limit, per })
        let now = 0
        for (let i = 0; i < limit; i++) store.consume('k', now)
        for (let round = 0; round < 5; round++) {
          const decision = store.consume('k', now)
          if (decision.allowed) continue
          now += decision.retryAfterMs
          if (!store.consume('k', now).allowed) {
            failures.push(`limit: ${limit}, per: ${per}`)
            break
          }
        }
      }
    }
    assert.deepEqual(failures, [])
  })

  test('the memory store forgets keys unused for `per`', ({ assert }) => {
    const store = new MemoryRateLimitStore({ limit: 10, per: 100 })
    for (let i = 0; i < 1000; i++) store.consume(`user:${i}`, i)
    assert.equal(store.size, 100)
    store.consume('user:0', 2000)
    assert.equal(store.size, 1)
  })

  test('a store failure is an UnexpectedError', async ({ assert }) => {
    const down = new Error('redis down')
    const result = await Tenace.policy()
      .withRateLimit({ store: { consume: () => Promise.reject(down) } })
      .settle(() => 1)
    assert.isTrue(
      !result.ok && result.error instanceof UnexpectedError && result.error.cause === down,
    )
  })

  test('uses the clock of the execution and returns the abort while waiting', async ({
    assert,
  }) => {
    const clock = new TestClock()
    const limit = new RateLimit({ limit: 1, per: 100, maxWait: 100 })
    const policy = Tenace.policy().with(limit)
    await policy.settle(() => 1, { clock })
    const waiting = policy.settle(() => clock.now(), { clock })
    await clock.advance(100)
    assert.deepEqual(await waiting, ok(100))

    const controller = new AbortController()
    const context = new ExecutionContext({ signal: controller.signal, clock })
    const aborted = limit.execute(context, async () => ok('never'))
    await tick()
    controller.abort('gave up')
    const result = await aborted
    assert.isTrue(
      !result.ok && result.error instanceof UnexpectedError && result.error.cause === 'gave up',
    )
  })

  test('emits rate_limit.rejected and rejects invalid options', async ({ assert }) => {
    const { types, instrumentation } = recorder()
    const policy = Tenace.policy({ instrumentation }).withRateLimit({ limit: 1, per: '1m' })
    await policy.settle(() => 1)
    await policy.settle(() => 1)
    assert.deepEqual(types(), ['rate_limit.rejected'])
    assert.throws(() => new MemoryRateLimitStore({ limit: 0, per: 1 }), RangeError)
  })
})

test.group('Lock', () => {
  test('runs one holder at a time per key', async ({ assert }) => {
    const policy = Tenace.policy().withLock({ key: 'job' })
    const order: string[] = []
    const gate = deferred<void>()
    const first = policy.execute(async () => {
      order.push('first:start')
      await gate.promise
      order.push('first:end')
    })
    const second = policy.execute(() => order.push('second'))
    await tick()
    assert.deepEqual(order, ['first:start'])
    gate.resolve()
    await Promise.all([first, second])
    assert.deepEqual(order, ['first:start', 'first:end', 'second'])
  })

  test('locks without a provider exclude each other across policies', async ({ assert }) => {
    const gate = deferred<void>()
    const order: string[] = []
    const first = Tenace.policy()
      .withLock({ key: 'shared' })
      .execute(async () => {
        order.push('first:start')
        await gate.promise
        order.push('first:end')
      })
    const second = Tenace.policy()
      .withLock({ key: 'shared' })
      .execute(() => order.push('second'))
    await tick()
    assert.deepEqual(order, ['first:start'])
    gate.resolve()
    await Promise.all([first, second])
    assert.deepEqual(order, ['first:start', 'first:end', 'second'])
  })

  test('rejects with LockNotAcquiredError after the timeout', async ({ assert }) => {
    const clock = new TestClock()
    const lock = new Lock({ timeout: 50 })
    const policy = Tenace.policy().with(lock)
    const gate = deferred<void>()
    const holder = policy.settle(() => gate.promise, { key: 'k', clock })
    const waiting = policy.settle(() => 'never', { key: 'k', clock })
    await clock.advance(50)
    const result = await waiting
    assert.isTrue(!result.ok && result.error instanceof LockNotAcquiredError)
    gate.resolve()
    await holder
  })

  test('uses the execution key and requires one', async ({ assert }) => {
    const policy = Tenace.policy().withLock()
    assert.deepEqual(await policy.settle(() => 1, { key: 'k' }), ok(1))
    await assert.rejects(() => policy.settle(() => 1), /needs a key/)
  })

  test('does not run the call when the caller aborted while acquiring', async ({ assert }) => {
    const controller = new AbortController()
    let released = false
    const late: LockProvider = {
      async acquire() {
        await tick()
        controller.abort('gave up')
        return { release: () => void (released = true) }
      },
    }
    let called = false
    const settled = Tenace.policy()
      .withLock({ provider: late, key: 'k' })
      .settle(() => (called = true), { signal: controller.signal })
    assert.equal(await settled.catch((error: unknown) => error), 'gave up')
    await tick()
    assert.isFalse(called)
    assert.isTrue(released)
  })

  test('the memory provider forgets keys it did not lock', async ({ assert }) => {
    const provider = new MemoryLockProvider()
    const signal = AbortSignal.abort()
    await provider.acquire('k', { signal, timeoutMs: undefined, ttlMs: undefined })
    assert.equal(provider.size, 0)
  })

  test('a provider failure is an UnexpectedError, a failed release is ignored', async ({
    assert,
  }) => {
    const down = new Error('redis down')
    const failing: LockProvider = { acquire: () => Promise.reject(down) }
    const result = await Tenace.policy()
      .withLock({ provider: failing, key: 'k' })
      .settle(() => 1)
    assert.isTrue(
      !result.ok && result.error instanceof UnexpectedError && result.error.cause === down,
    )

    const leaky: LockProvider = { acquire: async () => ({ release: () => Promise.reject(down) }) }
    assert.deepEqual(
      await Tenace.policy()
        .withLock({ provider: leaky, key: 'k' })
        .settle(() => 1),
      ok(1),
    )
  })
})

test.group('Dedupe', () => {
  test('concurrent executions with the same key share one run', async ({ assert }) => {
    const policy = Tenace.policy().withDedupe()
    let calls = 0
    const gate = deferred<string>()
    const run = () => (calls++, gate.promise)
    const a = policy.execute(run, { key: 'user:1' })
    const b = policy.execute(run, { key: 'user:1' })
    const c = policy.execute(() => 'other', { key: 'user:2' })
    gate.resolve('user')
    assert.deepEqual(await Promise.all([a, b, c]), ['user', 'user', 'other'])
    assert.equal(calls, 1)

    // once settled, the next call runs again
    await policy.execute(run, { key: 'user:1' })
    assert.equal(calls, 2)
  })

  test('the shared run survives one caller aborting, stops when all abort', async ({ assert }) => {
    const dedupe = new Dedupe()
    const policy = Tenace.policy().with(dedupe)
    let signal: AbortSignal | undefined
    const gate = deferred<string>()
    const run = (ctx: { signal: AbortSignal }) => ((signal = ctx.signal), gate.promise)

    const first = new AbortController()
    const second = new AbortController()
    const a = policy.settle(run, { signal: first.signal, key: 'k' })
    const b = policy.settle(run, { signal: second.signal, key: 'k' })
    await tick()
    first.abort('first')
    await a.catch(() => {})
    assert.isFalse(signal?.aborted)

    second.abort('second')
    await b.catch(() => {})
    assert.isTrue(signal?.aborted)
    assert.equal(dedupe.pending, 0)
    gate.resolve('late')
  })

  test('emits dedupe.joined', async ({ assert }) => {
    const { types, instrumentation } = recorder()
    const policy = Tenace.policy({ instrumentation }).withDedupe({ key: 'k' })
    await Promise.all([policy.execute(tick), policy.execute(tick)])
    assert.deepEqual(types(), ['dedupe.joined'])
  })

  test('needs a key, so calls of different functions are never merged', async ({ assert }) => {
    const policy = Tenace.policy().withDedupe()
    await assert.rejects(() => policy.execute(tick), /Dedupe needs a key/)
  })
})

test.group('Cache', () => {
  function mapCache() {
    const values = new Map<string, unknown>()
    const provider: CacheProvider = {
      async getOrSet<T>(key: string, factory: () => Promise<T>) {
        if (values.has(key)) return values.get(key) as T
        const value = await factory()
        values.set(key, value)
        return value
      },
    }
    return { values, provider }
  }

  test('serves cached successes and caches only successes', async ({ assert }) => {
    const { provider } = mapCache()
    const { types, instrumentation } = recorder()
    const policy = Tenace.policy({ instrumentation }).withCache({ provider })
    let calls = 0

    assert.deepEqual(await policy.settle(() => err('nope'), { key: 'k' }), err('nope'))
    assert.equal(await policy.execute(() => ++calls, { key: 'k' }), 1)
    assert.equal(await policy.execute(() => ++calls, { key: 'k' }), 1)
    assert.equal(calls, 1)
    assert.deepEqual(types(), ['cache.miss', 'cache.hit'])
  })

  test('fails open when the cache is down', async ({ assert }) => {
    const { types, instrumentation } = recorder()
    const broken: CacheProvider = { getOrSet: () => Promise.reject(new Error('cache down')) }
    const value = await Tenace.policy({ instrumentation })
      .withCache({ provider: broken, key: 'k' })
      .execute(() => 'live')
    assert.equal(value, 'live')
    assert.deepEqual(types(), ['cache.failed'])
  })

  test('keeps the produced value when the cache fails after the factory ran', async ({
    assert,
  }) => {
    let calls = 0
    const failsOnWrite: CacheProvider = {
      async getOrSet(_key, factory) {
        await factory()
        throw new Error('write failed')
      },
    }
    const value = await Tenace.policy()
      .withCache({ provider: failsOnWrite, key: 'k' })
      .execute(() => ++calls)
    assert.equal(value, 1)
    assert.equal(calls, 1)
  })

  test('never caches an err result, serves what the provider returns instead', async ({
    assert,
  }) => {
    const thrown: unknown[] = []
    const servesStale: CacheProvider = {
      async getOrSet<T>(_key: string, factory: () => Promise<T>) {
        try {
          return await factory()
        } catch (error) {
          thrown.push(error)
          return 'stale' as T
        }
      },
    }
    const result = await Tenace.policy()
      .withCache({ provider: servesStale, key: 'k' })
      .settle(() => err('down'))
    assert.deepEqual(result, ok('stale'))
    assert.instanceOf(thrown[0], Error)
  })

  test('does not run the call again when the cache fails while it runs', async ({ assert }) => {
    const { types, instrumentation } = recorder()
    const gate = deferred<void>()
    const timesOut: CacheProvider = {
      getOrSet(_key, factory) {
        void factory()
        return Promise.reject(new Error('cache timeout'))
      },
    }
    let calls = 0
    const value = Tenace.policy({ instrumentation })
      .withCache({ provider: timesOut, key: 'k' })
      .execute(async () => (await gate.promise, ++calls), { idempotent: false })
    await tick()
    gate.resolve()
    assert.equal(await value, 1)
    assert.equal(calls, 1)
    assert.deepEqual(types(), ['cache.failed'])
  })

  test('requires a key', async ({ assert }) => {
    const { provider } = mapCache()
    await assert.rejects(
      () =>
        Tenace.policy()
          .withCache({ provider })
          .settle(() => 1),
      /needs a key/,
    )
  })
})

test.group('StaleFallback', () => {
  test('serves the last success of the key when the call fails', async ({ assert }) => {
    const clock = new TestClock()
    const { events, instrumentation } = recorder()
    const policy = Tenace.policy({ instrumentation }).withStaleFallback()
    assert.equal(await policy.execute(() => 'fresh', { key: 'a', clock }), 'fresh')

    await clock.advance(1000)
    assert.equal(await policy.execute(() => err('down'), { key: 'a', clock }), 'fresh')
    assert.deepEqual(events, [{ type: 'fallback.stale', key: 'a', ageMs: 1000 }])
    await assert.rejects(() => policy.execute(() => err('down'), { key: 'b', clock }))
  })

  test('needs a key, so a value is never served to another function', async ({ assert }) => {
    const policy = Tenace.policy().withStaleFallback()
    await assert.rejects(() => policy.execute(() => 'fresh'), /StaleFallback needs a key/)
  })

  test('maxAge and maxEntries bound what can be served', async ({ assert }) => {
    const clock = new TestClock()
    const policy = Tenace.policy().withStaleFallback({ maxAge: 100, maxEntries: 1 })
    await policy.execute(() => 'a', { key: 'a', clock })
    await clock.advance(101)
    assert.isFalse((await policy.settle(() => err('down'), { key: 'a', clock })).ok)

    await policy.execute(() => 'a', { key: 'a', clock })
    await policy.execute(() => 'b', { key: 'b', clock })
    assert.isFalse((await policy.settle(() => err('down'), { key: 'a', clock })).ok)
    assert.deepEqual(await policy.settle(() => err('down'), { key: 'b', clock }), ok('b'))
  })
})
