import { test } from '@japa/runner'

import { backoff } from '../src/backoff.ts'
import { CircuitOpenError, UnexpectedError } from '../src/errors.ts'
import { listener, type TenaceEvent } from '../src/instrumentation.ts'
import { err, ok } from '../src/result/core.ts'
import { CircuitBreaker } from '../src/strategies/circuit_breaker/circuit_breaker.ts'
import type { CircuitState } from '../src/strategies/circuit_breaker/machine.ts'
import {
  type CircuitBreakerStore,
  MemoryCircuitBreakerStore,
} from '../src/strategies/circuit_breaker/store.ts'
import { type BreakerConfig, circuitBreakerMachine, type MachineState } from '../src/index.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'

const fail = () => {
  throw new Error('down')
}
const succeed = () => 'up'

function setup(options: ConstructorParameters<typeof CircuitBreaker>[0] = {}) {
  const clock = new TestClock()
  const breaker = new CircuitBreaker({ trip: { consecutive: 2 }, openFor: 1000, clock, ...options })
  const policy = Tenace.policy().with(breaker)
  return { clock, breaker, policy }
}

/**
 * A call that stays pending until `resolve()` / `reject()`.
 */
function pending() {
  let resolve!: (value: string) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { fn: () => promise, resolve, reject }
}

test.group('CircuitBreaker | closed and open', () => {
  test('opens after consecutive failures and rejects without calling fn', async ({ assert }) => {
    const { breaker, policy, clock } = setup()
    await policy.settle(fail)
    assert.equal(breaker.state, 'closed')
    await policy.settle(fail)
    assert.equal(breaker.state, 'open')

    let called = false
    await clock.advance(400)
    const result = await policy.settle(() => (called = true))
    assert.isFalse(called)
    assert.isFalse(result.ok)
    if (result.ok) return
    assert.instanceOf(result.error, CircuitOpenError)
    assert.equal((result.error as CircuitOpenError).state, 'open')
    assert.equal((result.error as CircuitOpenError).retryAfterMs, 600)
  })

  test('a success resets the consecutive failures', async ({ assert }) => {
    const { breaker, policy } = setup()
    await policy.settle(fail)
    await policy.settle(succeed)
    await policy.settle(fail)
    assert.equal(breaker.state, 'closed')
  })

  test('err() results count as failures', async ({ assert }) => {
    const { breaker, policy } = setup()
    await policy.settle(() => err('nope'))
    await policy.settle(() => err('nope'))
    assert.equal(breaker.state, 'open')
  })

  test('the circuit is shared by every policy using the instance', async ({ assert }) => {
    const { breaker, policy } = setup()
    const other = Tenace.policy().withTimeout(1000).with(breaker)
    await policy.settle(fail)
    await other.settle(fail)
    assert.equal(breaker.state, 'open')
    const result = await Tenace.policy().with(other).settle(succeed)
    assert.isTrue(!result.ok && result.error instanceof CircuitOpenError)
  })
})

test.group('CircuitBreaker | half-open', () => {
  test('admits one trial call after openFor, closes on success', async ({ assert }) => {
    const { breaker, policy, clock } = setup()
    await policy.settle(fail)
    await policy.settle(fail)
    await clock.advance(1000)
    assert.equal(breaker.state, 'half-open')

    const probe = pending()
    const trial = policy.settle(probe.fn)
    const rejected = await policy.settle(succeed)
    assert.isTrue(!rejected.ok && rejected.error instanceof CircuitOpenError)
    assert.equal((rejected as { error: CircuitOpenError }).error.state, 'half-open')

    probe.resolve('recovered')
    assert.deepEqual(await trial, ok('recovered'))
    assert.equal(breaker.state, 'closed')
  })

  test('reopens when the trial call fails, with a dynamic open duration', async ({ assert }) => {
    const openFor = backoff.exponential({ base: 1000, jitter: 'none' })
    const { breaker, policy, clock } = setup({ openFor })
    await policy.settle(fail)
    await policy.settle(fail)
    await clock.advance(1000)

    await policy.settle(fail)
    assert.equal(breaker.state, 'open')
    const rejected = await policy.settle(succeed)
    assert.equal((rejected as { error: CircuitOpenError }).error.retryAfterMs, 2000)

    await clock.advance(2000)
    await policy.settle(succeed)
    assert.equal(breaker.state, 'closed')

    // closing resets the open count
    await policy.settle(fail)
    await policy.settle(fail)
    const again = await policy.settle(succeed)
    assert.equal((again as { error: CircuitOpenError }).error.retryAfterMs, 1000)
  })

  test('permits and successes control the trial calls', async ({ assert }) => {
    const { breaker, policy, clock } = setup({ halfOpen: { permits: 2, successes: 2 } })
    await policy.settle(fail)
    await policy.settle(fail)
    await clock.advance(1000)

    const a = pending()
    const b = pending()
    const trials = [policy.settle(a.fn), policy.settle(b.fn)]
    const third = await policy.settle(succeed)
    assert.isTrue(!third.ok && third.error instanceof CircuitOpenError)

    a.resolve('a')
    await trials[0]
    assert.equal(breaker.state, 'half-open')
    b.resolve('b')
    await trials[1]
    assert.equal(breaker.state, 'closed')
  })

  test('a trial call running longer than maxWait counts as a failure', async ({ assert }) => {
    const { breaker, policy, clock } = setup({ halfOpen: { maxWait: 500 } })
    await policy.settle(fail)
    await policy.settle(fail)
    await clock.advance(1000)

    const hanging = pending()
    const trial = policy.settle(hanging.fn)
    await clock.advance(499)
    const rejected = await policy.settle(succeed)
    assert.equal((rejected as { error: CircuitOpenError }).error.retryAfterMs, 1)

    await clock.advance(1)
    const reopened = await policy.settle(succeed)
    assert.equal((reopened as { error: CircuitOpenError }).error.state, 'open')
    assert.equal(breaker.state, 'open')

    // the late result of the expired trial call is ignored
    hanging.resolve('late')
    await trial
    assert.equal(breaker.state, 'open')
  })

  test('a trial call succeeding after maxWait reopens the circuit', async ({ assert }) => {
    const { breaker, policy, clock } = setup({ halfOpen: { maxWait: 500 } })
    await policy.settle(fail)
    await policy.settle(fail)
    await clock.advance(1000)

    const slow = pending()
    const trial = policy.settle(slow.fn)
    await clock.advance(600)
    slow.resolve('late')
    await trial
    assert.equal(breaker.state, 'open')
  })
})

test.group('CircuitBreaker | classification', () => {
  test('calls aborted by the caller are ignored', async ({ assert }) => {
    const { breaker, policy } = setup({ trip: { consecutive: 1 } })
    const controller = new AbortController()
    let started!: () => void
    const running = new Promise<void>(resolve => (started = resolve))
    const settled = policy.settle(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
          started()
        }),
      { signal: controller.signal },
    )
    await running
    controller.abort()
    await settled.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(breaker.state, 'closed')
    await policy.settle(fail)
    assert.equal(breaker.state, 'open')
  })

  test('rejections of other policies are ignored', async ({ assert }) => {
    const { breaker: inner, policy: innerPolicy } = setup({ trip: { consecutive: 1 } })
    await innerPolicy.settle(fail)
    assert.equal(inner.state, 'open')

    const outer = new CircuitBreaker({ trip: { consecutive: 1 } })
    await innerPolicy.with(outer).settle(succeed)
    assert.equal(outer.state, 'closed')
  })

  test('classify can count values as failures and errors as ignored', async ({ assert }) => {
    const { breaker, policy } = setup({
      trip: { consecutive: 1 },
      classify: result => (result.ok ? (result.value === 503 ? 'failure' : 'success') : 'ignored'),
    })
    await policy.settle(fail)
    assert.equal(breaker.state, 'closed')
    await policy.settle(() => 503)
    assert.equal(breaker.state, 'open')
  })

  test('late results from before a transition are ignored', async ({ assert }) => {
    const { breaker, policy } = setup()
    const slow = pending()
    const late = policy.settle(slow.fn)
    await policy.settle(fail)
    await policy.settle(fail)
    assert.equal(breaker.state, 'open')

    slow.resolve('late success')
    await late
    assert.equal(breaker.state, 'open')
  })

  test('a trial call that rejects with a bug frees its permit', async ({ assert }) => {
    const { breaker, clock } = setup()
    const buggy = Tenace.policy()
      .withFallback(() => {
        throw new Error('bug')
      })
      .with(breaker)
    await buggy.settle(fail).catch(() => {})
    assert.equal(breaker.state, 'closed')

    const policy = Tenace.policy().with(breaker)
    await policy.settle(fail)
    await policy.settle(fail)
    await clock.advance(1000)
    await buggy.settle(fail).catch(() => {})
    assert.deepEqual(await policy.settle(succeed), ok('up'))
    assert.equal(breaker.state, 'closed')
  })
})

test.group('CircuitBreaker | isolate and events', () => {
  test('isolate rejects everything until released, isolations stack', async ({ assert }) => {
    const { breaker, policy } = setup()
    const releaseA = await breaker.isolate()
    const releaseB = await breaker.isolate()
    const rejected = await policy.settle(succeed)
    assert.equal(breaker.state, 'isolated')
    assert.equal((rejected as { error: CircuitOpenError }).error.state, 'isolated')
    assert.isUndefined((rejected as { error: CircuitOpenError }).error.retryAfterMs)

    await releaseA()
    await releaseA()
    assert.equal(breaker.state, 'isolated')
    await releaseB()
    assert.equal(breaker.state, 'closed')
    assert.deepEqual(await policy.settle(succeed), ok('up'))
  })

  test('an onStateChange that throws is reported and keeps the result of the call', async ({
    assert,
  }) => {
    const bug = new Error('listener bug')
    const reported: unknown[] = []
    const holder = globalThis as { reportError?: (error: unknown) => void }
    const original = holder.reportError
    holder.reportError = error => reported.push(error)
    try {
      const { policy, breaker } = setup({
        trip: { consecutive: 1 },
        onStateChange: () => {
          throw bug
        },
      })
      const result = await policy.settle(fail)
      assert.equal(breaker.state, 'open')
      assert.instanceOf(!result.ok && result.error, UnexpectedError)
      assert.equal(((result as { error: UnexpectedError }).error.cause as Error).message, 'down')
      assert.deepEqual(reported, [bug])
    } finally {
      if (original) holder.reportError = original
      else delete holder.reportError
    }
  })

  test('onStateChange reports transitions', async ({ assert }) => {
    const events: string[] = []
    const { policy, clock, breaker } = setup({
      onStateChange: ({ from, to }) => events.push(`${from}->${to}`),
    })
    await policy.settle(fail)
    await policy.settle(fail)
    await clock.advance(1000)
    await policy.settle(succeed)
    const release = await breaker.isolate()
    await release()
    assert.deepEqual(events, [
      'closed->open',
      'open->half-open',
      'half-open->closed',
      'closed->isolated',
      'isolated->closed',
    ])
  })

  test('observed calls report transitions made by unobserved calls', async ({ assert }) => {
    const { breaker, policy } = setup()
    const events: TenaceEvent[] = []
    const observed = Tenace.policy({ instrumentation: listener(e => events.push(e)) }).with(breaker)
    await observed.settle(succeed)
    await policy.settle(fail)
    await policy.settle(fail)
    assert.equal(breaker.state, 'open')

    await observed.settle(succeed)
    assert.deepEqual(
      events.map(e => (e.type === 'circuit.state_changed' ? `${e.from}->${e.to}` : e.type)),
      ['closed->open', 'circuit.rejected'],
    )
  })

  test('an unobserved call does not hide a transition from a concurrent observed one', async ({
    assert,
  }) => {
    const { breaker, policy } = setup({ trip: { consecutive: 1 } })
    const changes: string[] = []
    const observed = Tenace.policy({
      instrumentation: listener(e => {
        if (e.type === 'circuit.state_changed') changes.push(`${e.from}->${e.to}`)
      }),
    }).with(breaker)
    const call = pending()
    const settled = observed.settle(call.fn)
    await policy.settle(succeed)
    call.reject(new Error('down'))
    await settled
    assert.equal(breaker.state, 'open')
    assert.deepEqual(changes, ['closed->open'])
  })

  test('a slow state read never reports a transition older than the last one', async ({
    assert,
  }) => {
    const memory = new MemoryCircuitBreakerStore()
    // state reads resolve when the test says so, in any order
    const reads: { value: CircuitState; resolve: () => void }[] = []
    let held = true
    const store: CircuitBreakerStore = {
      admit: (...args) => memory.admit(...args),
      record: (...args) => memory.record(...args),
      isolate: (...args) => memory.isolate(...args),
      release: (...args) => memory.release(...args),
      state: (...args) => {
        const value = memory.state(...args)
        if (!held) return Promise.resolve(value)
        return new Promise(resolve => reads.push({ value, resolve: () => resolve(value) }))
      },
    }
    const read = async (index: number) => {
      for (let i = 0; i < 100 && reads.length <= index; i++) await Promise.resolve()
      return reads[index]!
    }
    const events: string[] = []
    const { policy, clock, breaker } = setup({
      trip: { consecutive: 1 },
      store,
      onStateChange: ({ from, to }) => events.push(`${from}->${to}`),
    })

    const failed = policy.settle(fail)
    ;(await read(0)).resolve()
    const opened = await read(1)
    assert.equal(opened.value, 'open')

    await clock.advance(1000)
    const succeeded = policy.settle(succeed)
    ;(await read(2)).resolve()
    const closed = await read(3)
    assert.equal(closed.value, 'closed')
    closed.resolve()
    await succeeded

    // the read made when the circuit opened completes last
    opened.resolve()
    await failed
    held = false
    await policy.settle(succeed)
    assert.equal(await breaker.getState(), 'closed')
    assert.deepEqual(events, ['closed->half-open', 'half-open->closed'])
  })

  test('an outer retry listing CircuitOpenError waits for the circuit to admit calls again', async ({
    assert,
  }) => {
    const { clock, breaker } = setup()
    const policy = Tenace.policy()
      .with(breaker)
      .withRetry({ retries: 3, delay: 10, retryOn: ['UnexpectedError', 'CircuitOpenError'] })
    let calls = 0
    const settled = policy.settle(() => (++calls <= 2 ? fail() : 'recovered'), { clock })

    await clock.advance(10)
    await clock.advance(1000)
    assert.deepEqual(await settled, ok('recovered'))
    assert.equal(calls, 3)
    assert.equal(breaker.state, 'closed')
  })
})

test.group('CircuitBreaker | store and options', () => {
  test('works with an asynchronous store', async ({ assert }) => {
    const memory = new MemoryCircuitBreakerStore()
    const store: CircuitBreakerStore = {
      admit: async (...args) => memory.admit(...args),
      record: async (...args) => memory.record(...args),
      isolate: async (...args) => memory.isolate(...args),
      release: async (...args) => memory.release(...args),
      state: async (...args): Promise<CircuitState> => memory.state(...args),
    }
    const breaker = new CircuitBreaker({ trip: { consecutive: 1 }, store })
    await Tenace.policy().with(breaker).settle(fail)
    assert.equal(await breaker.getState(), 'open')
    assert.throws(() => breaker.state, TypeError)
  })

  test('awaits stores returning thenables that are not native promises', async ({ assert }) => {
    const memory = new MemoryCircuitBreakerStore()
    // runs the operation only once awaited, like a lazy query builder
    const lazy = <T>(run: () => T): Promise<T> =>
      // oxlint-disable-next-line unicorn/no-thenable
      ({ then: (resolve: (value: T) => void) => resolve(run()) }) as unknown as Promise<T>
    const store: CircuitBreakerStore = {
      admit: (...args) => lazy(() => memory.admit(...args)),
      record: (...args) => lazy(() => memory.record(...args)),
      isolate: (...args) => lazy(() => memory.isolate(...args)),
      release: (...args) => lazy(() => memory.release(...args)),
      state: (...args) => lazy(() => memory.state(...args)),
    }
    const breaker = new CircuitBreaker({ trip: { consecutive: 1 }, store })
    const policy = Tenace.policy().with(breaker)

    assert.equal(await policy.execute(() => 'value'), 'value')
    await policy.settle(fail)
    assert.equal(memory.state(Date.now(), breaker.config), 'open')
  })

  test('a store failure is an UnexpectedError and never replaces the result of a call', async ({
    assert,
  }) => {
    const reported: unknown[] = []
    const holder = globalThis as { reportError?: (error: unknown) => void }
    const original = holder.reportError
    holder.reportError = error => reported.push(error)
    try {
      const down = new Error('store down')
      const memory = new MemoryCircuitBreakerStore()
      const failing = (failed: keyof CircuitBreakerStore): CircuitBreakerStore => ({
        admit: (...args) => (failed === 'admit' ? Promise.reject(down) : memory.admit(...args)),
        record: (...args) => (failed === 'record' ? Promise.reject(down) : memory.record(...args)),
        isolate: (...args) => memory.isolate(...args),
        release: (...args) => memory.release(...args),
        state: (...args) => {
          if (failed === 'state') throw down
          return memory.state(...args)
        },
      })

      let called = false
      const admit = await Tenace.policy()
        .withCircuitBreaker({ store: failing('admit') })
        .settle(() => (called = true))
      assert.isFalse(called)
      assert.isTrue(
        !admit.ok && admit.error instanceof UnexpectedError && admit.error.cause === down,
      )

      for (const failed of ['record', 'state'] as const) {
        const policy = Tenace.policy().withCircuitBreaker({
          store: failing(failed),
          onStateChange: () => {},
        })
        assert.deepEqual(await policy.settle(succeed), ok('up'), failed)
        assert.deepEqual(await policy.settle(() => err('nope')), err('nope'), failed)
      }
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.isNotEmpty(reported)
      assert.isTrue(reported.every(error => error === down))
    } finally {
      if (original) holder.reportError = original
      else delete holder.reportError
    }
  })

  test('state throws for a store returning a thenable that is not a native promise', ({
    assert,
  }) => {
    const memory = new MemoryCircuitBreakerStore()
    const store: CircuitBreakerStore = {
      admit: (...args) => memory.admit(...args),
      record: (...args) => memory.record(...args),
      isolate: (...args) => memory.isolate(...args),
      release: (...args) => memory.release(...args),
      state: (...args) => {
        const resolveWith = (resolve: (value: CircuitState) => void) =>
          resolve(memory.state(...args))
        // oxlint-disable-next-line unicorn/no-thenable
        return { then: resolveWith } as unknown as Promise<CircuitState>
      },
    }
    const breaker = new CircuitBreaker({ store })
    assert.throws(() => breaker.state, TypeError)
  })

  test('a custom store can be written with the exported state machine', async ({ assert }) => {
    // a key-value store holding the state as JSON, like Redis would
    const rows = new Map<string, string>()
    const load = (config: BreakerConfig): MachineState =>
      rows.has('circuit')
        ? (JSON.parse(rows.get('circuit')!) as MachineState)
        : circuitBreakerMachine.initialState(config)
    const save = (state: MachineState) => rows.set('circuit', JSON.stringify(state))
    const store: CircuitBreakerStore = {
      async admit(now, config) {
        const [state, admission] = circuitBreakerMachine.admit(load(config), now, config)
        save(state)
        return admission
      },
      async record(ticket, outcome, now, config) {
        save(circuitBreakerMachine.record(load(config), ticket, outcome, now, config))
      },
      async isolate(config) {
        save(circuitBreakerMachine.isolate(load(config)))
      },
      async release(config) {
        save(circuitBreakerMachine.release(load(config), config))
      },
      async state(now, config) {
        return circuitBreakerMachine.currentState(load(config), now)
      },
    }

    const { policy, breaker, clock } = setup({ store })
    await policy.settle(fail)
    await policy.settle(fail)
    assert.equal(await breaker.getState(), 'open')
    await clock.advance(1000)
    assert.deepEqual(await policy.settle(succeed), ok('up'))
    assert.equal(await breaker.getState(), 'closed')
  })

  test('withCircuitBreaker accepts an instance or options', async ({ assert }) => {
    const breaker = new CircuitBreaker()
    const shared = Tenace.policy().withCircuitBreaker(breaker)
    assert.strictEqual(shared.strategies[0], breaker)

    const own = Tenace.policy().withCircuitBreaker({ trip: { consecutive: 1 } })
    await own.settle(fail)
    const result = await own.settle(succeed)
    assert.isTrue(!result.ok && result.error instanceof CircuitOpenError)
  })

  test('rejects invalid options', ({ assert }) => {
    assert.throws(() => new CircuitBreaker({ trip: { consecutive: 0 } }), RangeError)
    assert.throws(() => new CircuitBreaker({ halfOpen: { permits: 0 } }), RangeError)
    assert.throws(() => new CircuitBreaker({ openFor: -1 }), RangeError)
    // a store keeps the state as JSON, where Infinity is lost
    assert.throws(() => new CircuitBreaker({ openFor: Infinity }), RangeError)
    assert.throws(() => new CircuitBreaker({ halfOpen: { maxWait: 0 } }), RangeError)
  })

  test('maxWait defaults to a stable value when openFor is a function', ({ assert }) => {
    const jittered = backoff.exponential({ base: '10s', random: () => 0 })
    assert.equal(new CircuitBreaker({ openFor: jittered }).config.halfOpen.maxWaitMs, 30_000)
    assert.equal(new CircuitBreaker({ openFor: 0 }).config.halfOpen.maxWaitMs, 30_000)
    assert.equal(new CircuitBreaker({ openFor: '5s' }).config.halfOpen.maxWaitMs, 5000)
  })
})

test.group('CircuitBreaker | rate windows', () => {
  test('count window: opens when the failure rate of the last calls reaches the threshold', async ({
    assert,
  }) => {
    const { breaker, policy } = setup({ trip: { rate: 0.5, calls: 4 } })
    for (const fn of [succeed, succeed, succeed, fail]) await policy.settle(fn)
    assert.equal(breaker.state, 'closed')

    // the oldest success leaves the window: 2 failures out of the last 4
    await policy.settle(fail)
    assert.equal(breaker.state, 'open')
  })

  test('count window: waits for minimumCalls', async ({ assert }) => {
    const { breaker, policy } = setup({ trip: { rate: 0.5, calls: 10, minimumCalls: 3 } })
    await policy.settle(fail)
    await policy.settle(fail)
    assert.equal(breaker.state, 'closed')
    await policy.settle(fail)
    assert.equal(breaker.state, 'open')
  })

  test('time window: counts the calls of the last duration only', async ({ assert }) => {
    const { breaker, policy, clock } = setup({
      trip: { rate: 0.5, duration: '10s', minimumCalls: 4, buckets: 10 },
    })
    await policy.settle(fail)
    await policy.settle(fail)
    await policy.settle(fail)
    await clock.advance(10_000)

    // the 3 failures expired: 1 failure out of 4 calls
    for (const fn of [succeed, succeed, succeed, fail]) await policy.settle(fn)
    assert.equal(breaker.state, 'closed')

    // still in the window: 2 failures out of 5, then 3 out of 6
    await clock.advance(5000)
    await policy.settle(fail)
    assert.equal(breaker.state, 'closed')
    await policy.settle(fail)
    assert.equal(breaker.state, 'open')
  })

  test('the window restarts empty after the circuit closes', async ({ assert }) => {
    const { breaker, policy, clock } = setup({ trip: { rate: 0.5, calls: 2 } })
    await policy.settle(fail)
    await policy.settle(fail)
    await clock.advance(1000)
    await policy.settle(succeed)
    assert.equal(breaker.state, 'closed')
    await policy.settle(fail)
    assert.equal(breaker.state, 'closed')
  })

  test('rejects invalid rate options', ({ assert }) => {
    assert.throws(() => new CircuitBreaker({ trip: { rate: 0, calls: 10 } }), RangeError)
    assert.throws(() => new CircuitBreaker({ trip: { rate: 1.5, calls: 10 } }), RangeError)
    assert.throws(() => new CircuitBreaker({ trip: { rate: 0.5, calls: 0 } }), RangeError)
    assert.throws(
      () => new CircuitBreaker({ trip: { rate: 0.5, calls: 10, minimumCalls: 11 } }),
      RangeError,
    )
    assert.throws(() => new CircuitBreaker({ trip: { rate: 0.5, duration: 0 } }), RangeError)
  })
})
