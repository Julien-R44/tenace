import type { LockNotAcquiredError, RateLimitError, UnexpectedError } from '../../src/errors.ts'
import type { ErrorOf } from '../../src/policy.ts'
import type { Result } from '../../src/result.ts'
import type { CacheProvider } from '../../src/strategies/cache.ts'
import { Tenace } from '../../src/tenace.ts'
import { type Equal, expectType } from './helpers.ts'

declare const provider: CacheProvider

const policy = Tenace.policy()
  .withDedupe()
  .withCache({ provider, ttl: '1m' })
  .withStaleFallback({ maxAge: '1h' })
  .withLock({ key: 'k' })
  .withRateLimit({ limit: 10, per: '1s' })
expectType<Equal<ErrorOf<typeof policy>, UnexpectedError | LockNotAcquiredError | RateLimitError>>()

const result = await policy
  .withFallbackOn(['RateLimitError'], error => error.retryAfterMs)
  .settle(() => 'x', { key: 'k' })
expectType<Equal<typeof result, Result<string | number, UnexpectedError | LockNotAcquiredError>>>()

// @ts-expect-error a store or limit/per is required
Tenace.policy().withRateLimit({ key: 'k' })
