import { test } from '@japa/runner'

import { systemClock } from '../src/clock.ts'
import { ExecutionContext } from '../src/context.ts'
import type { Result } from '../src/result/namespace.ts'
import { type Next, Strategy } from '../src/strategy.ts'
import { Tenace } from '../src/tenace.ts'
import { TestClock } from '../src/testing/test_clock.ts'

test.group('ExecutionContext', () => {
  test('defaults to attempt 1 and the system clock', ({ assert }) => {
    const context = new ExecutionContext({ signal: new AbortController().signal })
    assert.equal(context.attempt, 1)
    assert.strictEqual(context.clock, systemClock)
  })

  test('with() derives a new context and leaves the original untouched', ({ assert }) => {
    const signal = new AbortController().signal
    const clock = new TestClock()
    const base = new ExecutionContext({ signal, clock })
    const child = new AbortController().signal

    const next = base.with({ attempt: 2, signal: child })

    assert.notStrictEqual(next, base)
    assert.equal(next.attempt, 2)
    assert.strictEqual(next.signal, child)
    assert.strictEqual(next.clock, clock)
    assert.equal(base.attempt, 1)
    assert.strictEqual(base.signal, signal)
  })

  test('is frozen', ({ assert }) => {
    const context = new ExecutionContext({ signal: new AbortController().signal })
    assert.throws(() => {
      ;(context as { attempt: number }).attempt = 5
    })
  })

  test('abortable is false only while nothing can abort the signal', async ({ assert }) => {
    const seen: [string, boolean][] = []
    class Probe extends Strategy {
      readonly name = 'probe'
      readonly label: string
      constructor(label: string) {
        super()
        this.label = label
      }
      execute(context: ExecutionContext, next: Next): Promise<Result.Any> {
        seen.push([this.label, context.abortable])
        return next(context)
      }
    }
    const policy = Tenace.policy()
      .with(new Probe('inside timeout'))
      .withTimeout('1s')
      .withRetry({ retries: 0 })
      .with(new Probe('root'))

    await policy.execute(() => 1)
    await policy.execute(() => 1, { signal: new AbortController().signal })
    await Tenace.map([1], () => 1, { policy }).execute()

    const root = new ExecutionContext({ signal: new AbortController().signal, abortable: false })
    assert.isFalse(root.with({ attempt: 2, signal: root.signal }).abortable)
    // a context spread into a new one with another signal is abortable again
    const other = new AbortController().signal
    // oxlint-disable-next-line typescript/no-misused-spread
    assert.isTrue(new ExecutionContext({ ...root, signal: other }).abortable)

    assert.deepEqual(seen, [
      ['root', false],
      ['inside timeout', true],
      ['root', true],
      ['inside timeout', true],
      ['root', true],
      ['inside timeout', true],
    ])
  })
})
