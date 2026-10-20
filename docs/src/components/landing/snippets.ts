// Code shown on the landing page. The docs snippet check does not see these strings, so keep them in sync with the API by hand.

export const failure = `const policy = Tenace.policy({ name: 'users.get' })
  .withTimeout('1s')
  .withRetry({ retries: 3, retryOn: ['TimeoutError'] })
  .withCircuitBreaker({ trip: { consecutive: 5 }, openFor: '30s' })
  .withFallbackOn(['TimeoutError', 'CircuitOpenError'], () => null)

const user = await policy.execute(({ signal }) => fetchUser(id, { signal }))
// user: User | null`

export const concurrency = `// 10 reports at once, 100 more waiting
const reports = Tenace.policy()
  .withBulkhead({ concurrency: 10, queue: 100 })

// 10 searches per second and per user
const search = Tenace.policy()
  .withRateLimit({ limit: 10, per: '1s' })
await search.execute(() => searchUsers(query), {
  key: \`user:\${userId}\`,
})

// 1,000 ids, at most 5 requests in flight
const users = await Tenace.map(ids, fetchUser, {
  policy,
  concurrency: 5,
}).execute()`

export const typed = `const policy = Tenace.policy()
  .withTimeout('1s')
  .withCircuitBreaker()

type Failure = ErrorOf<typeof policy>
// UnexpectedError | TimeoutError | CircuitOpenError

const result = await policy.settle(() => fetchUser(id))

const message = Result.match(result, {
  ok: user => \`Hello \${user.name}\`,
  TimeoutError: () => 'The user service is slow',
  CircuitOpenError: () => 'The user service is down',
  UnexpectedError: () => 'Something went wrong',
})`

export const chaos = `// 1 call in 5 takes 2s longer: the timeout fires
const policy = Tenace.policy()
  .withChaos({ rate: 0.2, latency: '2s' })
  .withTimeout('1s')
  .withFallbackOn(['TimeoutError'], () => cachedUser)

// in tests: every policy throws until restore()
const restore = Tenace.chaos({
  throws: () => new Error('users API down'),
})`

export const testing = `import { TestClock } from '@julr/tenace/testing'

const clock = new TestClock()
const policy = Tenace.policy()
  .withTimeout('1s')
  .withRetry({ retries: 2, delay: '100ms' })

const hang = () => new Promise<never>(() => {})
const done = policy.settle(hang, { clock })

await clock.runAll() // 3 timeouts, 2 delays, 0ms
const result = await done // a TimeoutError`

export const observe = `import { openTelemetry } from '@julr/tenace-otel'

// a span per execution, an event per retry or timeout
Tenace.instrument(openTelemetry())

// or your own logger
Tenace.instrument(
  listener((event, info) => logger.info({ name: info.name, event })),
)`

export const quickstart = `import { Tenace } from '@julr/tenace'

const policy = Tenace.policy({ name: 'users.get' })
  .withTimeout('1s')
  .withRetry({ retries: 3 })
  .withCircuitBreaker()

const user = await policy.execute(({ signal }) => fetchUser(id, { signal }))`
