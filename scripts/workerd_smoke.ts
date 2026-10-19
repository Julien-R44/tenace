/**
 * Runs the built @julr/tenace bundle inside workerd (through Miniflare), with and without
 * nodejs_compat, to check the core stays runtime agnostic.
 */
import { readdir, readFile } from 'node:fs/promises'

import { Miniflare } from 'miniflare'

const buildDir = new URL('../packages/tenace/build/', import.meta.url)
const files = await readdir(buildDir, { recursive: true })
const buildModules = await Promise.all(
  files
    .filter(file => file.endsWith('.js'))
    .map(async file => ({
      type: 'ESModule' as const,
      path: `tenace/${file}`,
      contents: await readFile(new URL(file, buildDir), 'utf8'),
    })),
)

const worker = `
import { Tenace, TimeoutError, backoff, err } from './tenace/index.js'

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
    const batch = await Tenace.map([1, 2, 3], n => (n === 2 ? err('two') : n), { concurrency: 2 }).settle()

    return Response.json({
      value,
      calls,
      timeout: !timeout.ok && timeout.error instanceof TimeoutError,
      batch: batch.map(result => result.ok),
    })
  },
}
`

const expected = JSON.stringify({
  value: 'ok after 3',
  calls: 3,
  timeout: true,
  batch: [true, false, true],
})
let failed = false

for (const compatibilityFlags of [[], ['nodejs_compat']]) {
  const mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.js', contents: worker }, ...buildModules],
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
