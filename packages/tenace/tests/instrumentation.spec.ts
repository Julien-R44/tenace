import { AsyncLocalStorage } from 'node:async_hooks'
import diagnosticsChannel from 'node:diagnostics_channel'

import { test } from '@japa/runner'

import type { ExecutionContext } from '../src/context.ts'
import { TimeoutError } from '../src/errors.ts'
import {
  combine,
  type ExecutionInfo,
  type Instrumentation,
  listener,
  type TenaceEvent,
} from '../src/instrumentation.ts'
import type { EventMessage, ExecutionMessage } from '../src/internal/diagnostics_channel.ts'
import { err, ok } from '../src/result.ts'
import { CircuitBreaker } from '../src/strategies/circuit_breaker/circuit_breaker.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'

function recorder() {
  const events: TenaceEvent[] = []
  const infos: ExecutionInfo[] = []
  const instrumentation = listener((event, info) => {
    events.push(event)
    infos.push(info)
  })
  return { events, infos, instrumentation, types: () => events.map(event => event.type) }
}

/**
 * Records the around-advice calls as a flat log.
 */
function tracer(name: string, log: string[]): Instrumentation {
  return {
    async execution(info, run) {
      log.push(`${name}:execution:start:${info.name}`)
      const result = await run({
        async attempt(attempt, fn) {
          log.push(`${name}:attempt:${attempt.attempt}`)
          const attemptResult = await fn()
          log.push(`${name}:attempt:${attempt.attempt}:${attemptResult.ok ? 'ok' : 'err'}`)
          return attemptResult
        },
        event: event => log.push(`${name}:event:${event.type}`),
      })
      log.push(`${name}:execution:end:${result.ok ? 'ok' : 'err'}`)
      return result
    },
  }
}

test.group('Instrumentation | around-advice', () => {
  test('wraps the execution and each attempt, and sees the results', async ({ assert }) => {
    const log: string[] = []
    let calls = 0
    const value = await Tenace.policy({ name: 'users.get', instrumentation: tracer('t', log) })
      .withRetry({ retries: 2, delay: 0 })
      .execute(() => (++calls < 2 ? err('nope') : ok('user')))

    assert.equal(value, 'user')
    assert.deepEqual(log, [
      't:execution:start:users.get',
      't:attempt:1',
      't:attempt:1:err',
      't:event:retry.scheduled',
      't:attempt:2',
      't:attempt:2:ok',
      't:execution:end:ok',
    ])
  })

  test('the function runs inside the attempt hook (context propagation)', async ({ assert }) => {
    const storage = new AsyncLocalStorage<string>()
    const instrumentation: Instrumentation = {
      execution: (_info, run) =>
        storage.run('execution', () =>
          run({
            attempt: (attempt, fn) => storage.run(`attempt ${attempt.attempt}`, fn),
            event: () => {},
          }),
        ),
    }
    const seen: (string | undefined)[] = []
    await Tenace.policy({ instrumentation })
      .withRetry({ retries: 1, delay: 0 })
      .settle(() => {
        seen.push(storage.getStore())
        throw new Error('x')
      })
    assert.deepEqual(seen, ['attempt 1', 'attempt 2'])
  })

  test('execution info carries the name, strategies and attributes', async ({ assert }) => {
    const { infos, instrumentation } = recorder()
    await Tenace.policy({ name: 'policy-name', instrumentation })
      .withTimeout(1000)
      .withRetry({ retries: 1, delay: 0 })
      .settle(() => err('x'), { name: 'call-name', attributes: { tenant: 'acme' } })
    assert.deepEqual(infos[0], {
      name: 'call-name',
      strategies: ['retry', 'timeout'],
      attributes: { tenant: 'acme' },
    })
  })

  test('combine runs the first instrumentation outside the others', async ({ assert }) => {
    const log: string[] = []
    await Tenace.policy({ instrumentation: combine(tracer('a', log), tracer('b', log)) }).execute(
      () => 1,
    )
    assert.deepEqual(log, [
      'a:execution:start:tenace',
      'b:execution:start:tenace',
      'a:attempt:1',
      'b:attempt:1',
      'b:attempt:1:ok',
      'a:attempt:1:ok',
      'b:execution:end:ok',
      'a:execution:end:ok',
    ])
  })

  test('a throwing event handler is reported and does not affect the others', async ({
    assert,
  }) => {
    const reported: unknown[] = []
    const holder = globalThis as { reportError?: (error: unknown) => void }
    const original = holder.reportError
    holder.reportError = error => reported.push(error)
    const boom = new Error('listener bug')
    const { types, instrumentation } = recorder()
    try {
      const results = await Promise.all([
        Tenace.policy({
          instrumentation: combine(
            {
              execution: (_info, run) =>
                run({
                  attempt: (_attempt, fn) => fn(),
                  event: () => {
                    throw boom
                  },
                }),
            },
            instrumentation,
          ),
        })
          .withRetry({ retries: 1, delay: 0 })
          .settle(() => err('x')),
        Tenace.policy({
          instrumentation: listener(() => {
            throw boom
          }),
        })
          .withRetry({ retries: 1, delay: 0 })
          .settle(() => err('x')),
      ])
      assert.deepEqual(results, [err('x'), err('x')])
    } finally {
      if (original) holder.reportError = original
      else delete holder.reportError
    }
    assert.deepEqual(types(), ['retry.scheduled', 'retry.exhausted'])
    assert.deepEqual(reported, [boom, boom, boom, boom])
  })

  test('nothing observes by default', async ({ assert }) => {
    const context = (await Tenace.policy().execute(ctx => ctx)) as ExecutionContext
    assert.isFalse(context.observed)
  })
})

test.group('Instrumentation | global', () => {
  test('Tenace.instrument applies to every policy and returns a restore function', async ({
    assert,
  }) => {
    const global = recorder()
    const own = recorder()
    const restore = Tenace.instrument(global.instrumentation)
    try {
      await Tenace.policy()
        .withRetry({ retries: 1, delay: 0 })
        .settle(() => err('x'))
      await Tenace.policy({ instrumentation: own.instrumentation })
        .withRetry({ retries: 1, delay: 0 })
        .settle(() => err('x'))
    } finally {
      restore()
    }
    await Tenace.policy()
      .withRetry({ retries: 1, delay: 0 })
      .settle(() => err('x'))

    // the policy-level instrumentation is added to the global one
    assert.deepEqual(global.types(), [
      'retry.scheduled',
      'retry.exhausted',
      'retry.scheduled',
      'retry.exhausted',
    ])
    assert.deepEqual(own.types(), ['retry.scheduled', 'retry.exhausted'])
  })

  test('the same instrumentation set globally and on a policy runs once', async ({ assert }) => {
    const global = recorder()
    const restore = Tenace.instrument(global.instrumentation)
    try {
      await Tenace.policy({ instrumentation: global.instrumentation })
        .withRetry({ retries: 1, delay: 0 })
        .settle(() => err('x'))
    } finally {
      restore()
    }
    assert.deepEqual(global.types(), ['retry.scheduled', 'retry.exhausted'])
  })

  test('members of a combined instrumentation run once', async ({ assert }) => {
    const a = recorder()
    const b = recorder()
    const c = recorder()
    const run = (instrumentation: Instrumentation) =>
      Tenace.policy({ instrumentation })
        .withRetry({ retries: 1, delay: 0 })
        .settle(() => err('x'))
    const restore = Tenace.instrument(a.instrumentation, b.instrumentation)
    try {
      await run(a.instrumentation)
      await run(combine(b.instrumentation, c.instrumentation, c.instrumentation))
    } finally {
      restore()
    }
    const twice = ['retry.scheduled', 'retry.exhausted', 'retry.scheduled', 'retry.exhausted']
    assert.deepEqual(a.types(), twice)
    assert.deepEqual(b.types(), twice)
    assert.deepEqual(c.types(), ['retry.scheduled', 'retry.exhausted'])
  })

  test('instrumentation: false turns the global one off for a policy', async ({ assert }) => {
    const global = recorder()
    const restore = Tenace.instrument(global.instrumentation)
    try {
      await Tenace.policy({ instrumentation: false })
        .withRetry({ retries: 1, delay: 0 })
        .settle(() => err('x'))
    } finally {
      restore()
    }
    assert.deepEqual(global.types(), [])
  })

  test('restoring out of order keeps the latest setting', async ({ assert }) => {
    const log: string[] = []
    const run = () => Tenace.policy({ name: 'run' }).execute(() => 1)
    const restoreFirst = Tenace.instrument(tracer('first', log))
    const restoreSecond = Tenace.instrument(tracer('second', log))
    const restoreChaos = Tenace.chaos({ throws: () => new Error('chaos') })
    const restoreNoChaos = Tenace.chaos({ rate: 0 })
    restoreFirst()
    restoreChaos()
    try {
      assert.equal(await run(), 1)
    } finally {
      restoreSecond()
      restoreNoChaos()
    }
    await run()
    assert.deepEqual(log, [
      'second:execution:start:run',
      'second:attempt:1',
      'second:attempt:1:ok',
      'second:execution:end:ok',
    ])
  })
})

test.group('Instrumentation | events', () => {
  test('retry events', async ({ assert }) => {
    const { events, instrumentation } = recorder()
    await Tenace.policy({ instrumentation })
      .withRetry({ retries: 2, delay: 5 })
      .settle(() => err('boom'))
    assert.deepEqual(events, [
      { type: 'retry.scheduled', attempt: 1, delayMs: 5, error: 'boom' },
      { type: 'retry.scheduled', attempt: 2, delayMs: 5, error: 'boom' },
      { type: 'retry.exhausted', attempts: 3, error: 'boom' },
    ])
  })

  test('timeout and fallback events', async ({ assert }) => {
    const clock = new TestClock()
    const { types, instrumentation } = recorder()
    const done = Tenace.policy({ instrumentation })
      .withTimeout(10)
      .withFallbackOn(['TimeoutError'], error => error instanceof TimeoutError)
      .execute(() => new Promise(() => {}), { clock })
    await clock.advance(10)
    assert.isTrue(await done)
    assert.deepEqual(types(), ['timeout', 'fallback.used'])
  })

  test('circuit breaker and bulkhead events', async ({ assert }) => {
    const { events, instrumentation } = recorder()
    const breaker = new CircuitBreaker({
      name: 'users-api',
      trip: { consecutive: 1 },
      clock: new TestClock(),
    })
    const policy = Tenace.policy({ instrumentation }).with(breaker)
    await policy.settle(() => err('down'))
    await policy.settle(() => 'never')
    assert.deepEqual(events, [
      { type: 'circuit.state_changed', breaker: 'users-api', from: 'closed', to: 'open' },
      { type: 'circuit.rejected', breaker: 'users-api', state: 'open', retryAfterMs: 30_000 },
    ])

    events.length = 0
    const bulkhead = Tenace.policy({ instrumentation }).withBulkhead({
      concurrency: 1,
      name: 'pool',
    })
    const blocking = bulkhead.settle(() => new Promise(resolve => setTimeout(resolve, 20)))
    await bulkhead.settle(() => 1)
    await blocking
    assert.deepEqual(events, [
      { type: 'bulkhead.rejected', bulkhead: 'pool', running: 1, queued: 0 },
    ])
  })
})

test.group('Instrumentation | diagnostics_channel', () => {
  test('publishes executions, attempts and events when subscribed', async ({ assert }) => {
    const executions: ExecutionMessage[] = []
    const attempts: number[] = []
    const events: string[] = []
    const onExecution = (message: unknown) => executions.push(message as ExecutionMessage)
    const onAttempt = (message: unknown) => attempts.push((message as { attempt: number }).attempt)
    const onEvent = (message: unknown) => events.push((message as EventMessage).event.type)

    diagnosticsChannel.subscribe('tracing:tenace:execution:asyncEnd', onExecution)
    diagnosticsChannel.subscribe('tracing:tenace:attempt:start', onAttempt)
    diagnosticsChannel.subscribe('tenace:event', onEvent)
    try {
      await Tenace.policy({ name: 'dc' })
        .withRetry({ retries: 1, delay: 0 })
        .settle(() => err('x'))
    } finally {
      diagnosticsChannel.unsubscribe('tracing:tenace:execution:asyncEnd', onExecution)
      diagnosticsChannel.unsubscribe('tracing:tenace:attempt:start', onAttempt)
      diagnosticsChannel.unsubscribe('tenace:event', onEvent)
    }

    assert.lengthOf(executions, 1)
    assert.equal(executions[0]!.name, 'dc')
    assert.deepEqual(executions[0]!.result, err('x'))
    assert.deepEqual(attempts, [1, 2])
    assert.deepEqual(events, ['retry.scheduled', 'retry.exhausted'])

    const context = (await Tenace.policy().execute(ctx => ctx)) as ExecutionContext
    assert.isFalse(context.observed)
  })

  test('an attempt subscriber added during an execution sees the next attempts', async ({
    assert,
  }) => {
    const attempts: number[] = []
    const onEvent = () => {}
    const onAttempt = (message: unknown) => attempts.push((message as { attempt: number }).attempt)
    diagnosticsChannel.subscribe('tenace:event', onEvent)
    try {
      await Tenace.policy()
        .withRetry({ retries: 1, delay: 0 })
        .settle(() => {
          diagnosticsChannel.subscribe('tracing:tenace:attempt:start', onAttempt)
          return err('x')
        })
    } finally {
      diagnosticsChannel.unsubscribe('tracing:tenace:attempt:start', onAttempt)
      diagnosticsChannel.unsubscribe('tenace:event', onEvent)
    }
    assert.deepEqual(attempts, [2])
  })
})
