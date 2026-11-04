import type { Temporal } from 'temporal-polyfill'

/**
 * The native Temporal API (Node.js 26+, Bun), or the "temporal-polyfill"
 * ponyfill elsewhere (Node.js 22 and 24, workerd). The ponyfill is not
 * installed on globalThis, so the application globals stay untouched.
 */
export const temporal: typeof Temporal =
  (globalThis as { Temporal?: typeof Temporal }).Temporal ?? (await loadPolyfill())

async function loadPolyfill(): Promise<typeof Temporal> {
  const { Temporal: polyfill } = await import('temporal-polyfill')
  return polyfill
}
