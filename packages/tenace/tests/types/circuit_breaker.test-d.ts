import type { CircuitOpenError, TimeoutError, UnexpectedError } from '../../src/errors.ts'
import type { ErrorOf } from '../../src/policy.ts'
import { CircuitBreaker } from '../../src/strategies/circuit_breaker/circuit_breaker.ts'
import { Tenace } from '../../src/tenace.ts'
import { type Equal, expectType } from './helpers.ts'

const breaker = new CircuitBreaker({ trip: { consecutive: 3 }, openFor: attempt => attempt * 1000 })
const policy = Tenace.policy().withTimeout(100).with(breaker)
expectType<Equal<ErrorOf<typeof policy>, UnexpectedError | TimeoutError | CircuitOpenError>>()

const sugar = Tenace.policy().withCircuitBreaker({ openFor: '10s' })
expectType<Equal<ErrorOf<typeof sugar>, UnexpectedError | CircuitOpenError>>()

const handled = policy.withFallbackOn(['CircuitOpenError'], error => error.retryAfterMs)
expectType<Equal<ErrorOf<typeof handled>, UnexpectedError | TimeoutError>>()
expectType<
  Equal<Awaited<ReturnType<typeof handled.execute<() => string>>>, string | number | undefined>
>()
