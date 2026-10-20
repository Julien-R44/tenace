import type { TimeoutError, UnexpectedError } from '../../src/errors.ts'
import type { Result } from '../../src/result/namespace.ts'
import { Tenace } from '../../src/tenace.ts'
import type { NotFound } from '../helpers/strategies.ts'
import { type Equal, expectType } from './helpers.ts'

type User = { id: string }
declare const getUser: () => Promise<User>
declare const findPosts: () => Promise<Result<string[], NotFound>>

const values = await Tenace.all([getUser, findPosts]).execute()
expectType<Equal<typeof values, [User, string[]]>>()

const results = await Tenace.all([getUser, findPosts]).settle()
expectType<
  Equal<
    typeof results,
    [Result<User, UnexpectedError>, Result<string[], NotFound | UnexpectedError>]
  >
>()

const policy = Tenace.policy()
  .withTimeout(100)
  .withFallbackOn(['TimeoutError'], () => null)
const withPolicy = await Tenace.all([getUser], { policy }).settle()
expectType<Equal<typeof withPolicy, [Result<User | null, UnexpectedError>]>>()

const timed = Tenace.policy().withTimeout(100)
const mapped = await Tenace.map([1, 2], async id => ({ id: String(id) }), {
  policy: timed,
  concurrency: 2,
}).settle()
expectType<Equal<typeof mapped, Result<{ id: string }, UnexpectedError | TimeoutError>[]>>()
const mappedValues = await Tenace.map(['a'], item => item.length).execute()
expectType<Equal<typeof mappedValues, number[]>>()

// @ts-expect-error bound calls cannot be used as a batch policy
Tenace.all([getUser], { policy: Tenace.call(getUser) })
