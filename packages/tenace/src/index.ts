export { Batch, type BatchOptions, type BatchRunOptions } from './batch.ts'
export {
  backoff,
  type BackoffFn,
  type ExponentialBackoffOptions,
  type Jitter,
  type LinearBackoffOptions,
} from './backoff.ts'
export { type Clock, systemClock, type TimerHandle } from './clock.ts'
export { type Context, ExecutionContext, type ExecutionContextInit } from './context.ts'
export { type Duration, type DurationUnit, toMs } from './duration.ts'
export {
  BulkheadFullError,
  ChaosError,
  CircuitOpenError,
  type CircuitRejectionState,
  isTenaceError,
  LockNotAcquiredError,
  RateLimitError,
  TenaceError,
  TimeoutError,
  UnexpectedError,
} from './errors.ts'
export type { ErrorOfReturn, Fold, HandlerError, OtherError, ValueOfReturn } from './fold.ts'
export {
  type AttemptInfo,
  type Attributes,
  combine,
  type ExecutionInfo,
  type ExecutionScope,
  type Instrumentation,
  listener,
  noopInstrumentation,
  type RetryEventCause,
  type TenaceEvent,
} from './instrumentation.ts'
export type {
  AttemptMessage,
  EventMessage,
  ExecutionMessage,
} from './internal/diagnostics_channel.ts'
export {
  type AnyPolicy,
  type Composable,
  type CurrentError,
  type ErrorOf,
  type ExecuteOptions,
  type Fn,
  type KnownError,
  Policy,
  type PolicyOptions,
  type ReusablePolicy,
} from './policy.ts'
export { Result } from './result/namespace.ts'
export {
  registerResult,
  type ResultAdapter,
  type ResultTypeName,
  type ResultTypes,
  unregisterResult,
} from './result/registry.ts'
export { Bulkhead, type BulkheadOptions } from './strategies/bulkhead.ts'
export { Chaos, type ChaosOptions } from './strategies/chaos.ts'
export { Cache, type CacheOptions, type CacheProvider } from './strategies/cache.ts'
export { Dedupe, type DedupeOptions } from './strategies/dedupe.ts'
export {
  Lock,
  type LockAcquireOptions,
  type LockLease,
  type LockOptions,
  type LockProvider,
  MemoryLockProvider,
} from './strategies/lock.ts'
export {
  MemoryRateLimitStore,
  RateLimit,
  type RateLimitDecision,
  type RateLimitOptions,
  type RateLimitStore,
} from './strategies/rate_limit.ts'
export { StaleFallback, type StaleFallbackOptions } from './strategies/stale_fallback.ts'
export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type TripOptions,
} from './strategies/circuit_breaker/circuit_breaker.ts'
export type {
  Admission,
  BreakerConfig,
  CallOutcome,
  CircuitState,
  MachineState,
  Ticket,
  TimeBucket,
  TripConfig,
  WindowState,
} from './strategies/circuit_breaker/machine.ts'
/**
 * Pure state machine of the circuit breaker (`initialState`, `currentState`, `admit`,
 * `record`, `isolate`, `release`), to write your own `CircuitBreakerStore`.
 */
export * as circuitBreakerMachine from './strategies/circuit_breaker/machine.ts'
export {
  type CircuitBreakerStore,
  MemoryCircuitBreakerStore,
} from './strategies/circuit_breaker/store.ts'
export { Fallback, type FallbackHandler, MapError } from './strategies/fallback.ts'
export {
  Retry,
  type RetryCause,
  type RetryEvent,
  type RetryOptions,
  type ValueRetryOptions,
} from './strategies/retry.ts'
export { RetryBudget, type RetryBudgetOptions } from './strategies/retry_budget.ts'
export { Timeout, type TimeoutOptions } from './strategies/timeout.ts'
export { type AnyOp, type AnyStrategy, type Next, type Op, Strategy } from './strategy.ts'
export { Tenace, type TenaceEntry } from './tenace.ts'
export type { ByTag, TagOf } from './types.ts'
export { waitFor, type WaitForOptions } from './wait_for.ts'
