import { backoff } from '../../src/backoff.ts'
import { TenaceError, type TimeoutError, type UnexpectedError } from '../../src/errors.ts'
import type { OtherError } from '../../src/fold.ts'
import type { ErrorOf } from '../../src/policy.ts'
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

// comparing tags narrows even with undeclared errors in the union
Tenace.policy<HttpError>().withRetry({
  retries: 1,
  retryIf: error => error._tag === 'HttpError' && error.status >= 500,
})
