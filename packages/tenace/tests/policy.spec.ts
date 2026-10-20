import { test } from '@japa/runner'

import { ExecutionContext } from '../src/context.ts'
import { UnexpectedError } from '../src/errors.ts'
import { Result } from '../src/result/namespace.ts'
import type * as PolicyModule from '../src/policy.ts'
import { CircuitBreaker } from '../src/strategies/circuit_breaker/circuit_breaker.ts'
import type * as BreakerModule from '../src/strategies/circuit_breaker/circuit_breaker.ts'
import { isStrategy, type Next, Strategy } from '../src/strategy.ts'
import type * as StrategyModule from '../src/strategy.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'
import {
  BoomError,
  Counter,
  Explode,
  NotFound,
  Rescue,
  Trace,
  Twice,
} from './helpers/strategies.ts'

test.group('Policy | execute', () => {
  test('resolves with the value of sync and async functions', async ({ assert }) => {
    const policy = Tenace.policy()
    assert.equal(await policy.execute(() => 1), 1)
    assert.equal(await policy.execute(async () => 'a'), 'a')
  })

  test('unwraps a returned Result.ok()', async ({ assert }) => {
    assert.equal(await Tenace.policy().execute(() => Result.ok(42)), 42)
  })

  test('rethrows raw thrown values untouched, they are not policy errors', async ({ assert }) => {
    const policy = Tenace.policy()
    const raw = new Error('raw')
    const thrown = await policy.execute(() => Promise.reject(raw)).catch((error: unknown) => error)
    assert.strictEqual(thrown, raw)
    assert.isFalse(policy.isError(thrown))

    const primitive = await policy
      .execute(() => {
        throw 'nope'
      })
      .catch((error: unknown) => error)
    assert.equal(primitive, 'nope')
  })

  test('rethrows raw values that cannot be converted to a string', async ({ assert }) => {
    const raw = Object.create(null) as object
    const fn = (): never => {
      throw raw
    }
    assert.strictEqual(
      await Tenace.policy()
        .execute(fn)
        .catch((error: unknown) => error),
      raw,
    )
    const result = await Tenace.policy().settle(fn)
    assert.isTrue(!result.ok && result.error.cause === raw)
  })

  test('rejects with a returned Result.err() and recognizes it with isError()', async ({
    assert,
  }) => {
    const policy = Tenace.policy()
    const notFound = new NotFound('user')
    const thrown = await policy.execute(() => Result.err(notFound)).catch((error: unknown) => error)

    assert.strictEqual(thrown, notFound)
    assert.isTrue(policy.isError(thrown))
    assert.isFalse(Tenace.policy().isError(thrown))
    assert.isFalse(policy.isError(new NotFound('other')))
  })

  test('rejects with errors produced by strategies', async ({ assert }) => {
    const policy = Tenace.policy().with(new Explode())
    const thrown = await policy.execute(() => 1).catch((error: unknown) => error)
    assert.instanceOf(thrown, BoomError)
    assert.isTrue(policy.isError(thrown))
  })

  test('look-alike Results returned by the function are plain values', async ({ assert }) => {
    const payload = { ok: false, error: 'channel_not_found' }
    assert.strictEqual(await Tenace.policy().execute(() => payload), payload)
  })

  test('rejects with a TypeError when no function is given', async ({ assert }) => {
    const policy = Tenace.policy() as unknown as Record<
      'execute' | 'settle',
      (input: unknown) => Promise<unknown>
    >
    await assert.rejects(() => policy.execute(42), TypeError)
    const settled = policy.settle(42)
    assert.instanceOf(settled, Promise)
    await assert.rejects(() => settled, TypeError)
  })
})

test.group('Policy | settle', () => {
  test('resolves with Result.ok(value)', async ({ assert }) => {
    const result = await Tenace.policy().settle(async () => 'a')
    assert.isTrue(Result.is(result))
    assert.deepEqual(result, Result.ok('a'))
  })

  test('wraps raw throws in UnexpectedError, keeping the thrown value as cause', async ({
    assert,
  }) => {
    const raw = new Error('raw')
    const result = await Tenace.policy().settle(() => {
      throw raw
    })
    assert.isFalse(result.ok)
    if (result.ok) return
    assert.instanceOf(result.error, UnexpectedError)
    assert.strictEqual(result.error.cause, raw)
  })

  test('returns Result.err() of the function and of strategies as is', async ({ assert }) => {
    const notFound = new NotFound('x')
    assert.deepEqual(await Tenace.policy().settle(() => Result.err(notFound)), Result.err(notFound))

    const exploded = await Tenace.policy()
      .with(new Explode())
      .settle(() => 1)
    assert.isTrue(!exploded.ok && exploded.error instanceof BoomError)
  })

  test('a strategy that throws is a bug: the execution rejects', async ({ assert }) => {
    class Broken extends Strategy {
      readonly name = 'broken'
      execute(): never {
        throw new Error('bug in strategy')
      }
    }
    await assert.rejects(
      () =>
        Tenace.policy()
          .with(new Broken())
          .settle(() => 1),
      'bug in strategy',
    )
  })
})

test.group('Policy | composition', () => {
  test('the first strategy added is the innermost', async ({ assert }) => {
    const log: string[] = []
    const policy = Tenace.policy().with(new Trace('a', log)).with(new Trace('b', log))

    await policy.execute(() => log.push('fn'))
    assert.deepEqual(log, ['b:in', 'a:in', 'fn', 'a:out', 'b:out'])
    assert.deepEqual(policy.describe(), ['b', 'a'])
  })

  test('with() returns a new policy and leaves the original untouched', ({ assert }) => {
    const base = Tenace.policy()
    const extended = base.with(new Counter())
    assert.notStrictEqual(base, extended)
    assert.deepEqual(base.describe(), [])
    assert.deepEqual(extended.describe(), ['counter'])
  })

  test('a policy added with with() is inlined at that position', async ({ assert }) => {
    const log: string[] = []
    const inner = Tenace.policy().with(new Trace('i1', log)).with(new Trace('i2', log))
    const outer = Tenace.policy().with(new Trace('o1', log)).with(inner).with(new Trace('o2', log))

    await outer.execute(() => log.push('fn'))
    assert.deepEqual(outer.describe(), ['o2', 'i2', 'i1', 'o1'])
    assert.deepEqual(log, [
      'o2:in',
      'i2:in',
      'i1:in',
      'o1:in',
      'fn',
      'o1:out',
      'i1:out',
      'i2:out',
      'o2:out',
    ])
  })

  test('strategy instances are shared by identity between policies', async ({ assert }) => {
    const counter = new Counter()
    const a = Tenace.policy().with(counter)
    const b = Tenace.policy().with(new Explode()).with(counter)
    const nested = Tenace.policy().with(a)

    await a.execute(() => 1)
    await b.settle(() => 1)
    await nested.execute(() => 1)
    assert.equal(counter.calls, 3)
    assert.strictEqual(nested.strategies[0], counter)
  })

  test('policies and strategies of another copy of the package are recognized', async ({
    assert,
  }) => {
    const copies = {
      // @ts-expect-error query string loads a second, independent copy of the module
      policy: (await import('../src/policy.ts?copy')) as typeof PolicyModule,
      // @ts-expect-error query string loads a second, independent copy of the module
      strategy: (await import('../src/strategy.ts?copy')) as typeof StrategyModule,
      breaker: (await import(
        // @ts-expect-error query string loads a second, independent copy of the module
        '../src/strategies/circuit_breaker/circuit_breaker.ts?copy'
      )) as typeof BreakerModule,
    }

    const counter = new Counter()
    const inlined = Tenace.policy().with(new copies.policy.Policy([counter]) as never)
    assert.deepEqual(inlined.strategies, [counter])
    assert.equal(await inlined.execute(() => 1), 1)

    const breaker = new copies.breaker.CircuitBreaker()
    assert.isFalse(breaker instanceof CircuitBreaker)
    assert.strictEqual(Tenace.policy().withCircuitBreaker(breaker).strategies[0], breaker)

    class Foreign extends copies.strategy.Strategy {
      readonly name = 'foreign'
      execute(context: ExecutionContext, next: Next): Promise<Result.Any> {
        return next(context)
      }
    }
    assert.isTrue(isStrategy(new Foreign()))
  })

  test('fallback values of inner strategies flow out', async ({ assert }) => {
    const policy = Tenace.policy().with(new Explode()).with(new Rescue('rescued'))
    assert.equal(await policy.execute(() => 1), 'rescued')
  })
})

test.group('Policy | context', () => {
  test('the function receives a signal and a 1-based attempt', async ({ assert }) => {
    const context = await Tenace.policy().execute(ctx => ctx)
    assert.instanceOf(context, ExecutionContext)
    assert.instanceOf(context.signal, AbortSignal)
    assert.isFalse(context.signal.aborted)
    assert.equal(context.attempt, 1)
  })

  test('strategies derive the context seen by inner steps', async ({ assert }) => {
    const attempts: number[] = []
    await Tenace.policy()
      .with(new Twice())
      .execute(({ attempt }) => attempts.push(attempt))
    assert.deepEqual(attempts, [1, 2])
  })

  test('the clock option reaches strategies and the function', async ({ assert }) => {
    const clock = new TestClock(500)
    const seen = await Tenace.policy().execute(ctx => (ctx as ExecutionContext).clock, { clock })
    assert.strictEqual(seen, clock)
  })
})

test.group('Policy | caller abort', () => {
  test('rejects with the reason when the signal is already aborted, without calling fn', async ({
    assert,
  }) => {
    const reason = new Error('stop')
    let called = false
    const settled = Tenace.policy().settle(() => (called = true), {
      signal: AbortSignal.abort(reason),
    })

    assert.strictEqual(await settled.catch((error: unknown) => error), reason)
    assert.isFalse(called)
  })

  test('rejects as soon as the caller aborts, even if fn ignores the signal', async ({
    assert,
  }) => {
    const controller = new AbortController()
    const reason = new Error('stop')
    let fnSignal: AbortSignal | undefined
    const settled = Tenace.policy().settle(
      ({ signal }) => {
        fnSignal = signal
        return new Promise(() => {})
      },
      { signal: controller.signal },
    )

    setTimeout(() => controller.abort(reason), 5)
    assert.strictEqual(await settled.catch((error: unknown) => error), reason)
    assert.isTrue(fnSignal?.aborted)
  })

  test('execute() rejects with the reason too, and it is not a policy error', async ({
    assert,
  }) => {
    const policy = Tenace.policy()
    const controller = new AbortController()
    const executed = policy.execute(() => new Promise(() => {}), { signal: controller.signal })
    controller.abort()

    const thrown = await executed.catch((error: unknown) => error)
    assert.strictEqual(thrown, controller.signal.reason)
    assert.isFalse(policy.isError(thrown))
  })

  test('rejects when the caller aborts while fn runs synchronously', async ({ assert }) => {
    const controller = new AbortController()
    const reason = new Error('stop')
    const executed = Tenace.policy().execute(
      () => {
        controller.abort(reason)
        return 'value'
      },
      { signal: controller.signal },
    )
    assert.strictEqual(await executed.catch((error: unknown) => error), reason)
  })

  test('concurrent executions share one abort listener, removed once they settle', async ({
    assert,
  }) => {
    const { signal } = new AbortController()
    const calls = { add: 0, remove: 0 }
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      calls.add++
      add(...args)
    }
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      calls.remove++
      remove(...args)
    }
    const policy = Tenace.policy()
    await Promise.all(Array.from({ length: 50 }, () => policy.execute(() => 1, { signal })))
    assert.deepEqual(calls, { add: 1, remove: 1 })
  })

  test('an abort after completion changes nothing', async ({ assert }) => {
    const controller = new AbortController()
    const value = await Tenace.policy().execute(() => 1, { signal: controller.signal })
    controller.abort()
    assert.equal(value, 1)
  })
})

test.group('Tenace.call', () => {
  test('binds the function: execute() and settle() take only options', async ({ assert }) => {
    let calls = 0
    const call = Tenace.call(async () => ++calls).with(new Counter())

    assert.equal(await call.execute(), 1)
    assert.deepEqual(await call.settle(), Result.ok(2))
  })

  test('the bound function receives the context and the caller signal', async ({ assert }) => {
    const controller = new AbortController()
    const signal = await Tenace.call(ctx => ctx.signal).execute({ signal: controller.signal })
    assert.strictEqual(signal, controller.signal)
  })

  test('rejects non-functions', ({ assert }) => {
    assert.throws(() => Tenace.call(42 as never), TypeError)
  })
})
