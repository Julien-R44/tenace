import { backoff } from '../../src/backoff.ts'
import { TenaceError, type TimeoutError, type UnexpectedError } from '../../src/errors.ts'
import type { OtherError } from '../../src/fold.ts'
import type { CurrentError, ErrorOf } from '../../src/policy.ts'
import type { Result } from '../../src/result.ts'
import { Retry } from '../../src/strategies/retry.ts'
import { Tenace } from '../../src/tenace.ts'
import { NotFound } from '../helpers/strategies.ts'
import { type Equal, expectType } from './helpers.ts'

class HttpError extends TenaceError {
  readonly _tag = 'HttpError' as const
  readonly code = 'E_HTTP' as const
  readonly status: number = 500
}
declare const findUser: () => Promise<Result<{ id: string }, NotFound>>

// callbacks see the errors of the chain so far
Tenace.policy()
  .withTimeout('1s')
  .withRetry({
    retries: 3,
    retryOn: ['TimeoutError'],
    retryIf: (error, attempt) => {
      expectType<Equal<typeof error, UnexpectedError | OtherError | TimeoutError>>()
      expectType<Equal<typeof attempt, number>>()
      return error instanceof NotFound // instanceof on undeclared errors stays allowed
    },
    delay: (_attempt, error) => (error instanceof TenaceError ? '1s' : 100),
    onRetry: event =>
      expectType<Equal<typeof event.error, UnexpectedError | OtherError | TimeoutError>>(),
  })

// declared errors are visible
Tenace.policy<HttpError>().withRetry({
  retries: 2,
  retryIf: error => error instanceof HttpError && error.status >= 500,
})
Tenace.policy<HttpError>().withRetry({
  retries: 2,
  retryIf: error => error._tag === 'HttpError' || error._tag === 'UnexpectedError',
})

// Tenace.call: exact errors of the bound function
Tenace.call(findUser).withRetry({
  retries: 2,
  retryOn: ['NotFound'],
  retryIf: error => (expectType<Equal<typeof error, NotFound | UnexpectedError>>(), true),
})

// retry does not change the error channel
const retried = Tenace.policy()
  .withTimeout(10)
  .withRetry({ retries: 1, delay: backoff.exponential() })
expectType<Equal<ErrorOf<typeof retried>, UnexpectedError | TimeoutError>>()

// a Retry value composes with untyped callbacks
const shared = new Retry({ retries: 2, retryIf: error => error instanceof Error })
Tenace.policy().with(shared)

// @ts-expect-error tags must exist in the chain
Tenace.policy().withRetry({ retries: 1, retryOn: ['TimeoutError'] })
// @ts-expect-error opaque errors cannot be inspected
Tenace.policy().withRetry({ retries: 1, retryIf: error => error.status === 500 })
// @ts-expect-error retries is required
Tenace.policy().withRetry({ delay: 1 })

// a shared predicate is typed with CurrentError: callbacks also receive OtherError
const timedOut = Tenace.policy().withTimeout('1s')
const isTransient = (error: CurrentError<typeof timedOut>): boolean => error._tag === 'TimeoutError'
timedOut.withRetry({ retries: 1, retryIf: isTransient })
const isTransientError = (error: ErrorOf<typeof timedOut>): boolean => error._tag === 'TimeoutError'
// @ts-expect-error ErrorOf has no OtherError
timedOut.withRetry({ retries: 1, retryIf: isTransientError })

// comparing tags narrows even with undeclared errors in the union
Tenace.policy<HttpError>().withRetry({
  retries: 1,
  retryIf: error => error._tag === 'HttpError' && error.status >= 500,
})

/* ---- retryIfValue ---- */
type Res = { status: number; headers: Headers }
declare const fetchLike: () => Promise<Res>

// a bound call sees its value, onRetry and delay see the cause
const byValue = Tenace.call(fetchLike).withRetry({
  retries: 3,
  retryIfValue: (value, attempt) => {
    expectType<Equal<typeof value, Res>>()
    expectType<Equal<typeof attempt, number>>()
    return value.status === 503
  },
  delay: (_attempt, cause) => ('value' in cause ? 1000 : 100),
  onRetry: event => {
    if ('value' in event) expectType<Equal<typeof event.value, Res>>()
    else expectType<Equal<typeof event.error, UnexpectedError>>()
  },
})
// the error channel and the value are unchanged
expectType<Equal<ErrorOf<typeof byValue>, UnexpectedError>>()
const v1 = await byValue.execute()
expectType<Equal<typeof v1, Res>>()

// a reusable policy does not know its value yet
Tenace.policy().withRetry({
  retries: 1,
  retryIfValue: value => {
    expectType<Equal<typeof value, unknown>>()
    return value instanceof Response && value.status >= 500
  },
})
// @ts-expect-error a reusable policy cannot assume the type of its value
Tenace.policy().withRetry({ retries: 1, retryIfValue: (value: Res) => value.status === 503 })

// without retryIfValue, onRetry and delay still see the error only
Tenace.call(fetchLike).withRetry({
  retries: 1,
  delay: (_attempt, error) => (expectType<Equal<typeof error, UnexpectedError>>(), 0),
  onRetry: event => expectType<Equal<typeof event.error, UnexpectedError>>(),
})

// a standalone Retry with retryIfValue
void new Retry({ retries: 1, retryIfValue: (value: Res) => value.status === 503 })
