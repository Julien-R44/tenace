import { test } from '@japa/runner'

import { Scheduler } from '../src/internal/scheduler.ts'

test.group('Scheduler', () => {
  test('cancelled waiters leave the line, the others keep their order', async ({ assert }) => {
    const scheduler = new Scheduler(1)
    const release = scheduler.tryAcquire()!
    const controllers = [0, 1, 2, 3].map(() => new AbortController())
    const granted: number[] = []
    const waiters = controllers.map(async (controller, index) => {
      const next = await scheduler.acquire({ signal: controller.signal })
      if (next) granted.push(index)
      next?.()
    })
    controllers[0]!.abort()
    controllers[2]!.abort()
    assert.equal(scheduler.queued, 2)

    release()
    await Promise.all(waiters)
    assert.deepEqual(granted, [1, 3])
    assert.equal(scheduler.running, 0)
    assert.equal(scheduler.queued, 0)
  })

  test('cancelling many waiters costs linear time', async ({ assert }) => {
    const scheduler = new Scheduler(1)
    scheduler.tryAcquire()
    const controllers = Array.from({ length: 20_000 }, () => new AbortController())
    const waiters = controllers.map(controller => scheduler.acquire({ signal: controller.signal }))
    const started = performance.now()
    for (const controller of controllers) controller.abort()
    assert.isBelow(performance.now() - started, 1000)
    assert.equal(scheduler.queued, 0)
    assert.deepEqual(new Set(await Promise.all(waiters)), new Set([undefined]))
  })
})
