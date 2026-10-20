import { UnexpectedError } from './errors.ts'
import type { HandlerError, ValueOfReturn } from './fold.ts'
import { isThenable } from './internal/thenable.ts'
import { type AnyResult, err, type ErrorOfResult, ok, type Result, type ValueOf } from './result.ts'
import { toResult } from './result_registry.ts'
import type { ByTag, TagOf } from './types.ts'

type Settled<R, E> = Result<ValueOfReturn<R>, HandlerError<R> | E>

/**
 * What `Result.try(fn)` returns: a promise of a Result when `fn` returns a promise, and
 * either one when `fn` returns a promise only sometimes (or `unknown`). A function that only
 * throws (`never`) or returns `any` (parsed JSON) is not async.
 */
export type Attempt<R, E> = 0 extends 1 & R
  ? Result<R, E>
  : [R] extends [never]
    ? Result<never, E>
    : unknown extends R
      ? Result<unknown, unknown> | Promise<Result<unknown, unknown>>
      : [Extract<R, PromiseLike<unknown>>] extends [never]
        ? Settled<R, E>
        : [Exclude<R, PromiseLike<unknown>>] extends [never]
          ? Promise<Settled<Awaited<R>, E>>
          :
              | Settled<Exclude<R, PromiseLike<unknown>>, E>
              | Promise<Settled<Awaited<Extract<R, PromiseLike<unknown>>>, E>>

/**
 * Options of `Result.try()` to build your own error.
 */
export interface TryOptions<R, E> {
  /**
   * The function to run.
   */
  readonly try: () => R
  /**
   * Builds the error from what `try` throws or rejects with. Must not throw.
   */
  readonly catch: (cause: unknown) => E
}

const toUnexpected = (cause: unknown): UnexpectedError => new UnexpectedError(cause)

/**
 * Runs a function and turns what it throws (or rejects with) into an error: an
 * `UnexpectedError`, or what `catch` returns. A Result returned by the function is returned
 * as is, not nested.
 *
 * ```ts
 * const user = await Result.try(() => db.find(id))
 * const url = Result.try({
 *   try: () => new URL(input),
 *   catch: cause => new InvalidUrl(input, { cause }),
 * })
 * ```
 */
export function attempt<R>(fn: () => R): Attempt<R, UnexpectedError>
export function attempt<R, E>(options: TryOptions<R, E>): Attempt<R, E>
export function attempt(
  input: (() => unknown) | TryOptions<unknown, unknown>,
): AnyResult | Promise<AnyResult> {
  const fn = typeof input === 'function' ? input : input.try
  const mapError = typeof input === 'function' ? toUnexpected : input.catch

  let value: unknown
  try {
    value = fn()
    if (!isThenable(value)) return toResult(value)
  } catch (cause) {
    return err(mapError(cause))
  }
  return Promise.resolve(value)
    .then(toResult)
    .catch((cause: unknown) => err(mapError(cause)))
}

/**
 * The values of every Result, in order, or the first error in input order.
 *
 * ```ts
 * const rows = Result.all(lines.map(parseRow)) // Result<Row[], RowError>
 * const pair = Result.all([parseA(a), parseB(b)]) // Result<[A, B], ErrorA | ErrorB>
 * ```
 */
export function all<const Rs extends readonly AnyResult[]>(
  results: Rs,
): Result<{ -readonly [K in keyof Rs]: ValueOf<Rs[K]> }, ErrorOfResult<Rs[number]>> {
  const values: unknown[] = []
  for (const result of results) {
    if (!result.ok) return result as Result<never, ErrorOfResult<Rs[number]>>
    values.push(result.value)
  }
  return ok(values as { -readonly [K in keyof Rs]: ValueOf<Rs[K]> })
}

/**
 * Splits Results into their values and their errors, each in input order.
 *
 * ```ts
 * const { values, errors } = Result.partition(lines.map(parseRow))
 * ```
 */
export function partition<const Rs extends readonly AnyResult[]>(
  results: Rs,
): { values: ValueOf<Rs[number]>[]; errors: ErrorOfResult<Rs[number]>[] } {
  const values: ValueOf<Rs[number]>[] = []
  const errors: ErrorOfResult<Rs[number]>[] = []
  for (const result of results) {
    if (result.ok) values.push(result.value as ValueOf<Rs[number]>)
    else errors.push(result.error as ErrorOfResult<Rs[number]>)
  }
  return { values, errors }
}

/**
 * The value of an ok Result. Throws what `execute()` would reject with: the error of an err
 * Result, or the raw thrown value that an `UnexpectedError` wraps.
 *
 * ```ts
 * const user = Result.unwrap(await findUser(id))
 * ```
 */
export function unwrap<R extends AnyResult>(result: R): ValueOf<R> {
  if (result.ok) return result.value as ValueOf<R>
  if (result.error instanceof UnexpectedError) throw result.error.cause
  throw result.error
}

/**
 * The error of an err Result. Throws when the Result is ok, or when `tag` is given and the
 * error has another `_tag`. Mostly useful in tests.
 *
 * ```ts
 * const error = Result.unwrapErr(await signup(input), 'EmailTaken') // EmailTaken
 * ```
 */
export function unwrapErr<R extends AnyResult>(result: R): ErrorOfResult<R>
export function unwrapErr<R extends AnyResult, const K extends TagOf<ErrorOfResult<R>>>(
  result: R,
  tag: K,
): ByTag<ErrorOfResult<R>, K>
export function unwrapErr(result: AnyResult, tag?: string): unknown {
  if (result.ok) throw new Error('Expected an err Result, got an ok Result')
  if (tag === undefined) return result.error

  const actual = (result.error as { _tag?: unknown } | null | undefined)?._tag
  if (actual !== tag) {
    const got = typeof actual === 'string' ? `"${actual}"` : 'an untagged error'
    throw new Error(`Expected tag "${tag}", got ${got}`, { cause: result.error })
  }
  return result.error
}
