/**
 * Bundles a worker importing the built @julr/tenace package, as Wrangler would, and runs it
 * inside workerd (through Miniflare), with and without nodejs_compat, to check the core
 * stays runtime agnostic. workerd has no native Temporal, so the clock runs on the
 * temporal-polyfill ponyfill.
 */
import { fileURLToPath } from 'node:url'

import { Miniflare } from 'miniflare'
import { rolldown } from 'rolldown'

const packages = {
  '@julr/tenace': fileURLToPath(new URL('../packages/tenace/build/index.js', import.meta.url)),
  '@julr/tenace/testing': fileURLToPath(
    new URL('../packages/tenace/build/testing/index.js', import.meta.url),
  ),
}

const worker = `
import { CircuitBreaker, Result, Tenace, TimeoutError, backoff, clock } from '@julr/tenace'
import { FakeClock } from '@julr/tenace/testing'

export default {
  async fetch() {
    let calls = 0
    const policy = Tenace.policy({ name: 'smoke' })
      .withTimeout(20)
      .withRetry({ retries: 2, delay: backoff.constant(1), retryOn: ['TimeoutError'] })
      .withCircuitBreaker({ trip: { consecutive: 5 } })
      .withFallbackOn(['CircuitOpenError'], () => 'fallback')

    const value = await policy.execute(async ({ signal, attempt }) => {
      calls++
      if (attempt < 3) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) })
      })
      return 'ok after ' + attempt
    })
    const timeout = await Tenace.policy().withTimeout(5).settle(() => new Promise(() => {}))
    const batch = await Tenace.map([1, 2, 3], n => (n === 2 ? Result.err('two') : n), { concurrency: 2 }).settle()

    // the system clock
    const now = clock.now()
    let observations = 0
    const polled = await clock.until(() => (++observations === 3 ? 'ready' : undefined), {
      within: '1s',
      every: 5,
    })

    // one fake drives the timeouts, the retry delays and the circuit breaker
    const time = clock.fake(new Date('2026-01-01T00:00:00Z'))
    let faked
    try {
      const breaker = new CircuitBreaker({ trip: { consecutive: 3 }, openFor: '1m' })
      const hanging = Tenace.policy()
        .withTimeout('5s')
        .with(breaker)
        .withRetry({ retries: 2, delay: '10s', retryOn: ['TimeoutError'] })
        .settle(() => new Promise(() => {}))
      await time.advanceBy('35s')
      const result = await hanging
      const opened = breaker.state
      await time.advanceBy('1m')
      faked = {
        fake: time instanceof FakeClock,
        now: clock.now().toString(),
        timeout: !result.ok && result.error instanceof TimeoutError,
        breaker: [opened, breaker.state],
        pendingTimers: time.pendingTimers,
      }
    } finally {
      time[Symbol.dispose]()
    }

    return Response.json({
      value,
      calls,
      timeout: !timeout.ok && timeout.error instanceof TimeoutError,
      batch: batch.map(result => result.ok),
      temporal: typeof globalThis.Temporal,
      now: Math.abs(now.epochMilliseconds - Date.now()) < 5000,
      polled: [polled, observations],
      faked,
    })
  },
}
`

const bundle = await rolldown({
  input: 'worker.js',
  platform: 'neutral',
  plugins: [
    {
      name: 'smoke-worker',
      resolveId: id => (id === 'worker.js' ? id : packages[id as keyof typeof packages]),
      load: id => (id === 'worker.js' ? worker : undefined),
    },
  ],
})
const { output } = await bundle.generate({ format: 'esm', codeSplitting: false })
await bundle.close()

const expected = JSON.stringify({
  value: 'ok after 3',
  calls: 3,
  timeout: true,
  batch: [true, false, true],
  temporal: 'undefined',
  now: true,
  polled: ['ready', 3],
  faked: {
    fake: true,
    now: '2026-01-01T00:01:35Z',
    timeout: true,
    breaker: ['open', 'half-open'],
    pendingTimers: 0,
  },
})
let failed = false

for (const compatibilityFlags of [[], ['nodejs_compat']]) {
  const mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.js', contents: output[0].code }],
    compatibilityDate: '2026-08-01',
    compatibilityFlags,
  })
  try {
    const response = await mf.dispatchFetch('http://localhost/')
    const body = JSON.stringify(await response.json())
    const label = compatibilityFlags.length ? 'workerd + nodejs_compat' : 'workerd'
    if (body === expected) {
      console.log(`${label}: ok`)
    } else {
      failed = true
      console.error(`${label}: unexpected result ${body}`)
    }
  } finally {
    await mf.dispose()
  }
}

if (failed) process.exitCode = 1
