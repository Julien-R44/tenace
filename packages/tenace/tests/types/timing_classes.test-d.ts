import { TimeoutError, type UnexpectedError } from '../../src/errors.ts'
import type { ErrorOf } from '../../src/policy.ts'
import { err, type Result } from '../../src/result/core.ts'
import { Fallback, MapError } from '../../src/strategies/fallback.ts'
import { Retry } from '../../src/strategies/retry.ts'
import { Tenace } from '../../src/tenace.ts'
import { NotFound } from '../helpers/strategies.ts'
import { type Equal, expectType } from './helpers.ts'

const base = Tenace.policy().withTimeout(10)

// a standalone Retry accepts any tag, a typed one only its tags
base.with(new Retry({ retries: 2, retryOn: ['TimeoutError'] }))
const typed = new Retry({ retries: 1, retryIf: (_error: NotFound) => true, retryOn: ['NotFound'] })
expectType<Equal<typeof typed, Retry<NotFound>>>()
// @ts-expect-error unknown tag
new Retry<NotFound>({ retries: 1, retryOn: ['TimeoutError'] })

// a catch-all Fallback empties the channel and adds its value
const caught = base.with(new Fallback(() => 0))
expectType<Equal<ErrorOf<typeof caught>, never>>()
const value = await caught.settle(() => 'x')
expectType<Equal<typeof value, Result<string | number, never>>>()

// errors returned by the handler are added
const failing = base.with(new Fallback(() => err(new NotFound('x'))))
expectType<Equal<ErrorOf<typeof failing>, NotFound>>()

// a type guard removes the guarded errors, a plain predicate removes nothing
const guarded = base.with(
  new Fallback(
    () => null,
    (error): error is TimeoutError => error instanceof TimeoutError,
  ),
)
expectType<Equal<ErrorOf<typeof guarded>, UnexpectedError>>()
const predicate = base.with(
  new Fallback(
    () => null,
    () => true,
  ),
)
expectType<Equal<ErrorOf<typeof predicate>, UnexpectedError | TimeoutError>>()

// like withFallbackWhen, a guard on an untagged class removes nothing
class Untagged extends Error {}
const untagged = base.with(
  new Fallback(
    () => null,
    (error): error is Untagged => error instanceof Untagged,
  ),
)
expectType<Equal<ErrorOf<typeof untagged>, UnexpectedError | TimeoutError>>()

// MapError replaces the channel with what it returns
const mapped = base.with(new MapError(() => new NotFound('x')))
expectType<Equal<ErrorOf<typeof mapped>, NotFound>>()
