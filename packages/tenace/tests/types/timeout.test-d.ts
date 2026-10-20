import type { TimeoutError, UnexpectedError } from '../../src/errors.ts'
import type { ErrorOf } from '../../src/policy.ts'
import type { Result } from '../../src/result/namespace.ts'
import { Timeout } from '../../src/strategies/timeout.ts'
import { Tenace } from '../../src/tenace.ts'
import type { NotFound } from '../helpers/strategies.ts'
import { type Equal, expectType } from './helpers.ts'

declare const findUser: () => Promise<Result<{ id: string }, NotFound>>

const sugar = Tenace.policy().withTimeout('1s')
const explicit = Tenace.policy().with(new Timeout(1000, { mode: 'cooperative' }))
expectType<Equal<ErrorOf<typeof sugar>, UnexpectedError | TimeoutError>>()
expectType<Equal<ErrorOf<typeof explicit>, UnexpectedError | TimeoutError>>()

const result = await Tenace.call(findUser).withTimeout(100).settle()
expectType<
  Equal<typeof result, Result<{ id: string }, NotFound | UnexpectedError | TimeoutError>>
>()

// @ts-expect-error unknown unit
Tenace.policy().withTimeout('1 sec')
// @ts-expect-error unknown mode
Tenace.policy().withTimeout(1, { mode: 'lazy' })
