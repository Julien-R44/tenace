import { backoff } from '../../src/backoff.ts'
import { Tenace } from '../../src/tenace.ts'
import { type Equal, expectType } from './helpers.ts'

const done = Tenace.waitFor(async ({ signal, attempt }) => {
  expectType<Equal<typeof signal, AbortSignal>>()
  expectType<Equal<typeof attempt, number>>()
  return true
})
expectType<Equal<typeof done, Promise<void>>>()

await Tenace.waitFor(() => true, { interval: backoff.exponential({ max: '5s' }), timeout: '1m' })
await Tenace.waitFor(() => true, { interval: attempt => `${attempt}s` })

// @ts-expect-error the condition returns a boolean
await Tenace.waitFor(() => 'ready')
declare const configuredDuration: string
await Tenace.waitFor(() => true, { interval: configuredDuration, timeout: configuredDuration })
await Tenace.waitFor(() => true, { timeout: '1 min' })
