import { test } from '@japa/runner'

import { systemClock } from '../src/clock.ts'
import { ExecutionContext } from '../src/context.ts'
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
})
