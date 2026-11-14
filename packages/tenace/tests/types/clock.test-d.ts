import type { CancelledError, TimeoutError, UnexpectedError } from '../../src/index.ts'
import {
  clock,
  type Context,
  type PollOptions,
  Result,
  TenaceError,
  type WaitForOptions,
} from '../../src/index.ts'
import { assertType, type Equal, expectType } from './helpers.ts'
import type { AppResult } from '../helpers/app_result.ts'

class DeploymentGone extends TenaceError {
  readonly _tag = 'DeploymentGone' as const
  readonly code = 'E_DEPLOYMENT_GONE' as const
}

type PollError = TimeoutError | CancelledError | UnexpectedError
declare const isHealthy: (context: Context) => Promise<Result<boolean, DeploymentGone>>
declare const readJob: (context: Context) => Result<{ id: string; ready: boolean }, DeploymentGone>

const ready = await clock.waitFor(isHealthy)
expectType<Equal<typeof ready, Result<void, DeploymentGone | PollError>>>()
const plainReady = await clock.waitFor(async ({ signal, attempt }) => {
  expectType<Equal<typeof signal, AbortSignal>>()
  expectType<Equal<typeof attempt, number>>()
  return attempt > 1
})
expectType<Equal<typeof plainReady, Result<void, PollError>>>()
const syncReady = await clock.waitFor(() => true)
expectType<Equal<typeof syncReady, Result<void, PollError>>>()
const failed = await clock.waitFor(() => Result.err(new DeploymentGone('gone')))
expectType<Equal<typeof failed, Result<void, DeploymentGone | PollError>>>()

function checkBooleanConditions<T extends boolean>(
  condition: (context: Context) => T,
  asyncCondition: (context: Context) => PromiseLike<T>,
): void {
  const ready = clock.waitFor(condition)
  expectType<Equal<typeof ready, Promise<Result<void, PollError>>>>()
  const asyncReady = clock.waitFor(asyncCondition)
  expectType<Equal<typeof asyncReady, Promise<Result<void, PollError>>>>()
}
void checkBooleanConditions

function checkConditionErrors<T extends boolean, E>(
  value: T,
  condition: (context: Context) => Result<T, E> | PromiseLike<Result<T, E>>,
  mixedCondition: (context: Context) => T | Result<T, E> | PromiseLike<T | Result<T, E>>,
): void {
  const success = clock.waitFor(() => Result.ok(value))
  expectType<Equal<typeof success, Promise<Result<void, PollError>>>>()
  const ready = clock.waitFor(condition)
  expectType<Equal<typeof ready, Promise<Result<void, E | PollError>>>>()
  const mixedReady = clock.waitFor(mixedCondition)
  expectType<Equal<typeof mixedReady, Promise<Result<void, E | PollError>>>>()
}
void checkConditionErrors

declare const foreignHealthy: () => Promise<AppResult<boolean, DeploymentGone>>
const foreignReady = await clock.waitFor(foreignHealthy)
expectType<Equal<typeof foreignReady, typeof ready>>()
const foreignPolled = await clock.poll(foreignHealthy, { until: value => value })
expectType<Equal<typeof foreignPolled, Result<boolean, DeploymentGone | PollError>>>()

const job = await clock.poll(readJob, {
  until: value => {
    expectType<Equal<typeof value, { id: string; ready: boolean }>>()
    return value.ready
  },
})
expectType<Equal<typeof job, Result<{ id: string; ready: boolean }, DeploymentGone | PollError>>>()
const asyncJob = await clock.poll(async context => readJob(context), { until: job => job.ready })
expectType<Equal<typeof asyncJob, typeof job>>()
const asyncPredicate = await clock.poll(readJob, { until: async job => job.ready })
expectType<Equal<typeof asyncPredicate, typeof job>>()

const nullable = await clock.poll(() => null as null | undefined | number | false, {
  until: value => value === 0,
})
expectType<Equal<typeof nullable, Result<null | undefined | number | false, PollError>>>()
const mixed = await clock.poll(({ attempt }) => (attempt > 1 ? Result.ok(7) : 0), {
  until: value => value === 7,
})
expectType<Equal<typeof mixed, Result<number, PollError>>>()

Result.match(ready, {
  ok: value => expectType<Equal<typeof value, void>>(),
  DeploymentGone: error => expectType<Equal<typeof error, DeploymentGone>>(),
  TimeoutError: error => assertType<number>(error.timeoutMs),
  CancelledError: error => assertType<unknown>(error.cause),
  UnexpectedError: error => assertType<unknown>(error.cause),
})
// @ts-expect-error cancellation must also be handled
Result.match(ready, {
  ok: () => {},
  DeploymentGone: () => {},
  TimeoutError: () => {},
  UnexpectedError: () => {},
})

const options: WaitForOptions = { timeout: '30s', interval: attempt => attempt * 100 }
await clock.waitFor(isHealthy, options)
const pollOptions: PollOptions<number> = { ...options, until: value => value === 0 }
await clock.poll(() => 0, pollOptions)

// @ts-expect-error a condition returns a boolean, not a truthy number
await clock.waitFor(() => 1)
// @ts-expect-error successful Results must contain a boolean
await clock.waitFor(async () => Result.ok('ready'))
// @ts-expect-error poll requires an explicit acceptance predicate
await clock.poll(readJob, { timeout: '1s' })
// @ts-expect-error the predicate receives the unwrapped job, not its Result
await clock.poll(readJob, { until: value => value.ok })
// @ts-expect-error poll predicates must resolve to a boolean
await clock.poll(readJob, { until: async () => 'ready' })
