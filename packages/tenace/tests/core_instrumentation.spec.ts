import { test } from '@japa/runner'

import type { ExecutionContext } from '../src/context.ts'
import type { ExecutionScope, Instrumentation, TenaceEvent } from '../src/instrumentation.ts'
import { type AnyResult, err, ok } from '../src/result.ts'
import { type Next, Strategy } from '../src/strategy.ts'
import { Tenace } from '../src/tenace.ts'

const scope: ExecutionScope = { attempt: (_info, fn) => fn(), event: () => {} }

/**
 * Captures what `reportError` receives during `fn`.
 */
async function reporting(fn: () => Promise<void>): Promise<unknown[]> {
  const reported: unknown[] = []
  const holder = globalThis as { reportError?: (error: unknown) => void }
  const original = holder.reportError
  holder.reportError = error => reported.push(error)
  try {
    await fn()
    await new Promise(resolve => setTimeout(resolve, 0))
  } finally {
    if (original) holder.reportError = original
    else delete holder.reportError
  }
  return reported
}

function counted() {
  let calls = 0
  return { fn: () => ok(++calls), calls: () => calls }
}

test.group('Instrumentation | contract', () => {
  test('run executes the function once, a second call rejects', async ({ assert }) => {
    const { fn, calls } = counted()
    let second: unknown
    const instrumentation: Instrumentation = {
      async execution(_info, run) {
        const result = await run(scope)
        second = await run(scope).catch((error: unknown) => error)
        return result
      },
    }
    const reported = await reporting(async () => {
      assert.equal(await Tenace.policy({ instrumentation }).execute(fn), 1)
    })
    assert.equal(calls(), 1)
    assert.instanceOf(second, TypeError)
    assert.deepEqual(reported, [second])
  })

  test('a refused run() is reported once, even if its promise is ignored', async ({ assert }) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    const instrumentation: Instrumentation = {
      async execution(_info, run) {
        const result = await run(scope)
        void run(scope)
        return result
      },
    }
    try {
      const reported = await reporting(async () => {
        await Tenace.policy({ instrumentation }).execute(() => 1)
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.lengthOf(reported, 1)
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('errors of the instrumentation are reported, the real result is kept', async ({
    assert,
  }) => {
    const before = new Error('before run')
    const after = new Error('after run')
    const throwsBefore: Instrumentation = {
      execution: () => {
        throw before
      },
    }
    const throwsAfter: Instrumentation = {
      async execution(_info, run) {
        await run(scope)
        throw after
      },
    }
    const lies: Instrumentation = {
      async execution(_info, run) {
        await run(scope)
        return err('fake')
      },
    }
    const { fn, calls } = counted()
    const reported = await reporting(async () => {
      assert.equal(await Tenace.policy({ instrumentation: throwsBefore }).execute(fn), 1)
      assert.deepEqual(await Tenace.policy({ instrumentation: throwsAfter }).settle(fn), ok(2))
      assert.deepEqual(await Tenace.policy({ instrumentation: lies }).settle(fn), ok(3))
    })
    assert.equal(calls(), 3)
    assert.deepEqual(reported, [before, after])
  })

  test('an instrumentation that settles without calling run is reported', async ({ assert }) => {
    const { fn, calls } = counted()
    const instrumentation: Instrumentation = { execution: async () => ok('skipped') }
    const reported = await reporting(async () => {
      assert.equal(await Tenace.policy({ instrumentation }).execute(fn), 1)
    })
    assert.equal(calls(), 1)
    assert.lengthOf(reported, 1)
    assert.instanceOf(reported[0], TypeError)
  })

  test('a throwing attempt hook or event handler does not break retries', async ({ assert }) => {
    const boom = new Error('hook bug')
    let attempts = 0
    const instrumentation: Instrumentation = {
      execution: (_info, run) =>
        run({
          attempt: () => {
            throw boom
          },
          event: () => {
            throw boom
          },
        }),
    }
    const reported = await reporting(async () => {
      const value = await Tenace.policy({ instrumentation })
        .withRetry({ retries: 2, delay: 0 })
        .execute(() => (++attempts < 3 ? err('again') : ok('done')))
      assert.equal(value, 'done')
    })
    assert.equal(attempts, 3)
    // 3 attempts, 2 retry.scheduled events
    assert.deepEqual(reported, [boom, boom, boom, boom, boom])
  })

  test('events emitted once the execution settled are dropped', async ({ assert }) => {
    let last: ExecutionContext | undefined
    class Keep extends Strategy {
      readonly name = 'keep'
      execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
        last = context
        return next(context)
      }
    }
    const events: TenaceEvent[] = []
    const instrumentation: Instrumentation = {
      execution: (_info, run) => run({ attempt: (_info, fn) => fn(), event: e => events.push(e) }),
    }
    await Tenace.policy({ instrumentation })
      .with(new Keep())
      .execute(() => last?.emit({ type: 'custom', name: 'during' }))
    last?.emit({ type: 'custom', name: 'after' })
    assert.deepEqual(events, [{ type: 'custom', name: 'during' }])
  })
})

test.group('Instrumentation | caller abort', () => {
  test('a slow or stuck instrumentation does not delay the abort', async ({ assert }) => {
    const controller = new AbortController()
    const instrumentation: Instrumentation = {
      async execution(_info, run) {
        await run(scope).catch(() => {})
        return new Promise<never>(() => {})
      },
    }
    const settled = Tenace.policy({ instrumentation }).execute(() => new Promise(() => {}), {
      signal: controller.signal,
    })
    controller.abort('stop')
    assert.equal(await settled.catch((error: unknown) => error), 'stop')
  })

  test('run rejects with the abort reason, even if the function never settles', async ({
    assert,
  }) => {
    const controller = new AbortController()
    const reason = new Error('stop')
    let seen: unknown
    const instrumentation: Instrumentation = {
      async execution(_info, run) {
        try {
          return await run(scope)
        } catch (error) {
          seen = error
          throw error
        }
      },
    }
    const executed = Tenace.policy({ instrumentation }).execute(() => new Promise(() => {}), {
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(reason), 1)
    assert.strictEqual(await executed.catch((error: unknown) => error), reason)
    assert.strictEqual(seen, reason)
  })
})
