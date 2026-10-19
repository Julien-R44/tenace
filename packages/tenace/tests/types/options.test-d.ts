import type { VerrouAdapterOptions } from '../../src/adapters/verrou.ts'
import type { BatchOptions, BatchRunOptions } from '../../src/batch.ts'
import type { ExponentialBackoffOptions, LinearBackoffOptions } from '../../src/backoff.ts'
import type { ExecutionContextInit } from '../../src/context.ts'
import type { TenaceEvent } from '../../src/instrumentation.ts'
import type { ExecuteOptions, PolicyOptions } from '../../src/policy.ts'
import type { BulkheadOptions } from '../../src/strategies/bulkhead.ts'
import type { CacheOptions } from '../../src/strategies/cache.ts'
import type { ChaosOptions } from '../../src/strategies/chaos.ts'
import type {
  CircuitBreakerOptions,
  TripOptions,
} from '../../src/strategies/circuit_breaker/circuit_breaker.ts'
import type { DedupeOptions } from '../../src/strategies/dedupe.ts'
import type { LockAcquireOptions, LockOptions } from '../../src/strategies/lock.ts'
import type { RateLimitOptions } from '../../src/strategies/rate_limit.ts'
import type { RetryOptions, ValueRetryOptions } from '../../src/strategies/retry.ts'
import type { RetryBudgetOptions } from '../../src/strategies/retry_budget.ts'
import type { StaleFallbackOptions } from '../../src/strategies/stale_fallback.ts'
import type { TimeoutOptions } from '../../src/strategies/timeout.ts'
import { Tenace } from '../../src/tenace.ts'
import { waitFor, type WaitForOptions } from '../../src/wait_for.ts'
import { type Equal, expectType } from './helpers.ts'

/**
 * Optional properties of `T` (each member of a union) that reject an explicit `undefined`
 * under `exactOptionalPropertyTypes`.
 */
type RejectsUndefined<T> = T extends unknown
  ? {
      [K in keyof T]-?: {} extends Pick<T, K>
        ? { [P in K]: undefined } extends Pick<T, K>
          ? never
          : K
        : never
    }[keyof T]
  : never

/* ---- every option forwarded from an optional value type checks ---- */
expectType<Equal<RejectsUndefined<ExecuteOptions>, never>>()
expectType<Equal<RejectsUndefined<PolicyOptions>, never>>()
expectType<Equal<RejectsUndefined<BatchOptions<unknown>>, never>>()
expectType<Equal<RejectsUndefined<BatchRunOptions>, never>>()
expectType<Equal<RejectsUndefined<WaitForOptions>, never>>()
expectType<Equal<RejectsUndefined<ExponentialBackoffOptions>, never>>()
expectType<Equal<RejectsUndefined<LinearBackoffOptions>, never>>()
expectType<Equal<RejectsUndefined<ExecutionContextInit>, never>>()
expectType<Equal<RejectsUndefined<Extract<TenaceEvent, { type: 'custom' }>>, never>>()
expectType<Equal<RejectsUndefined<TimeoutOptions>, never>>()
expectType<Equal<RejectsUndefined<RetryOptions>, never>>()
expectType<Equal<RejectsUndefined<ValueRetryOptions>, never>>()
expectType<Equal<RejectsUndefined<RetryBudgetOptions>, never>>()
expectType<Equal<RejectsUndefined<CircuitBreakerOptions>, never>>()
expectType<Equal<RejectsUndefined<NonNullable<CircuitBreakerOptions['halfOpen']>>, never>>()
expectType<Equal<RejectsUndefined<TripOptions>, never>>()
expectType<Equal<RejectsUndefined<BulkheadOptions>, never>>()
expectType<Equal<RejectsUndefined<RateLimitOptions>, never>>()
expectType<Equal<RejectsUndefined<LockOptions>, never>>()
expectType<Equal<RejectsUndefined<LockAcquireOptions>, never>>()
expectType<Equal<RejectsUndefined<CacheOptions>, never>>()
expectType<Equal<RejectsUndefined<DedupeOptions>, never>>()
expectType<Equal<RejectsUndefined<StaleFallbackOptions>, never>>()
expectType<Equal<RejectsUndefined<ChaosOptions<Error, string>>, never>>()
expectType<Equal<RejectsUndefined<VerrouAdapterOptions>, never>>()

/* ---- forwarding options of a wrapper ---- */
declare const opts: { signal?: AbortSignal; name?: string; delay?: number }
const policy = Tenace.policy({ name: opts.name })
await policy.execute(() => 1, { signal: opts.signal, name: opts.name })
await Tenace.call(() => 1, { name: opts.name }).settle({ signal: opts.signal })
Tenace.policy().withRetry({ retries: 2, delay: opts.delay, onRetry: undefined })
Tenace.policy().withTimeout(1, { mode: undefined })
await Tenace.all([() => 1], { policy: undefined, concurrency: undefined }).execute({
  signal: opts.signal,
})
await waitFor(() => true, { signal: opts.signal, timeout: undefined })
