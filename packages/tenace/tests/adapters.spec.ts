import { test } from '@japa/runner'
import { memoryStore } from '@verrou/core/drivers/memory'
import { Verrou } from '@verrou/core'
import { BentoCache, bentostore } from 'bentocache'
import { memoryDriver } from 'bentocache/drivers/memory'
import { RateLimiterMemory } from 'rate-limiter-flexible'

import { bentocache } from '../src/adapters/bentocache.ts'
import { rateLimiterFlexible } from '../src/adapters/rate_limiter_flexible.ts'
import { verrou } from '../src/adapters/verrou.ts'
import { LockNotAcquiredError, RateLimitError } from '../src/errors.ts'
import { err, ok } from '../src/result.ts'
import { Tenace } from '../src/tenace.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test.group('Adapters | rate-limiter-flexible', () => {
  test('maps allowed and rejected consumptions', async ({ assert }) => {
    const store = rateLimiterFlexible(new RateLimiterMemory({ points: 1, duration: 60 }))
    const policy = Tenace.policy().withRateLimit({ store, key: 'user:1' })
    assert.deepEqual(await policy.settle(() => 1), ok(1))
    const rejected = await policy.settle(() => 2)
    assert.isTrue(!rejected.ok && rejected.error instanceof RateLimitError)
    assert.isAbove((rejected as { error: RateLimitError }).error.retryAfterMs, 59_000)
  })

  test('store errors reject', async ({ assert }) => {
    const store = rateLimiterFlexible({ consume: () => Promise.reject(new Error('redis down')) })
    await assert.rejects(async () => store.consume('k', 0), 'redis down')
  })
})

test.group('Adapters | verrou', () => {
  test('acquires and releases locks, times out', async ({ assert }) => {
    const locks = new Verrou({ default: 'memory', stores: { memory: { driver: memoryStore() } } })
    const policy = Tenace.policy().withLock({ provider: verrou(locks), key: 'job', timeout: 50 })

    let release!: () => void
    const holder = policy.settle(() => new Promise<void>(resolve => (release = resolve)))
    await new Promise(resolve => setTimeout(resolve, 10))
    const rejected = await policy.settle(() => 'never')
    assert.isTrue(!rejected.ok && rejected.error instanceof LockNotAcquiredError)

    release()
    await holder
    assert.deepEqual(await policy.settle(() => 'after'), ok('after'))
  })

  test('honors the timeout exactly: 0 tries once, others do not overshoot', async ({ assert }) => {
    const locks = new Verrou({ default: 'memory', stores: { memory: { driver: memoryStore() } } })
    await locks.createLock('job').acquire()
    const provider = verrou(locks)

    for (const timeout of [0, 50]) {
      const startedAt = Date.now()
      const result = await Promise.race([
        Tenace.policy()
          .withLock({ provider, key: 'job', timeout })
          .settle(() => 'never'),
        sleep(1000).then(() => 'still waiting'),
      ])
      assert.isTrue(typeof result === 'object' && !result.ok)
      assert.instanceOf((result as { error: unknown }).error, LockNotAcquiredError)
      assert.isBelow(Date.now() - startedAt, timeout + 150)
    }
  })

  test('stops waiting when the signal aborts', async ({ assert }) => {
    const locks = new Verrou({ default: 'memory', stores: { memory: { driver: memoryStore() } } })
    await locks.createLock('job').acquire()
    const controller = new AbortController()
    const acquiring = verrou(locks).acquire('job', {
      signal: controller.signal,
      timeoutMs: undefined,
      ttlMs: undefined,
    })
    await sleep(10)
    controller.abort()
    assert.isUndefined(await Promise.race([acquiring, sleep(1000).then(() => 'still waiting')]))
  })

  test('uses the Verrou default ttl when the lock has none', async ({ assert }) => {
    const ttls: unknown[] = []
    const provider = verrou({
      createLock: (_name, ttl) => {
        ttls.push(ttl)
        return { acquireImmediately: async () => true, release: async () => {} }
      },
    })
    await Tenace.policy()
      .withLock({ provider, key: 'job' })
      .settle(() => 1)
    await Tenace.policy()
      .withLock({ provider, key: 'job', ttl: '1s' })
      .settle(() => 1)
    assert.deepEqual(ttls, [undefined, 1000])
  })
})

test.group('Adapters | bentocache', () => {
  test('caches successes with the ttl', async ({ assert }) => {
    const bento = new BentoCache({
      default: 'memory',
      stores: { memory: bentostore().useL1Layer(memoryDriver()) },
    })
    const policy = Tenace.policy().withCache({ provider: bentocache(bento), ttl: '1m' })
    let calls = 0

    assert.deepEqual(await policy.settle(() => err('nope'), { key: 'k' }), err('nope'))
    assert.equal(await policy.execute(() => ++calls, { key: 'k' }), 1)
    assert.equal(await policy.execute(() => ++calls, { key: 'k' }), 1)
    assert.equal(calls, 1)
    await bento.disconnectAll()
  })

  test('an err result refreshing a graced entry is not cached and does not crash', async ({
    assert,
  }) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    const bento = new BentoCache({
      default: 'memory',
      grace: '1h',
      stores: { memory: bentostore().useL1Layer(memoryDriver()) },
    })
    const policy = Tenace.policy().withCache({ provider: bentocache(bento), ttl: 20 })

    try {
      assert.deepEqual(await policy.settle(() => 'fresh', { key: 'k' }), ok('fresh'))
      await sleep(40)
      // the stale value is served while the call refreshes it in the background
      const stale = await policy.settle(async () => (await sleep(10), err('down')), { key: 'k' })
      assert.deepEqual(stale, ok('fresh'))
      await sleep(20)
      // a call failing right away also gets the stale value bentocache serves
      assert.deepEqual(await policy.settle(() => err('down'), { key: 'k' }), ok('fresh'))
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await bento.disconnectAll()
    }
  })
})
