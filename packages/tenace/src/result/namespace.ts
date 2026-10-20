import { match } from './match.ts'
import {
  type AnyResult,
  type Err,
  err,
  type ErrorOfResult,
  isResult,
  type Ok,
  ok,
  type ValueOf,
} from './core.ts'
import {
  all,
  attempt,
  type Attempt,
  partition,
  type TryOptions,
  unwrap,
  unwrapErr,
} from './helpers.ts'

// module-level aliases: the namespace members below share the names of the imported types
type OkOf<T> = Ok<T>
type ErrOf<E> = Err<E>
type ValueOfAlias<R> = ValueOf<R>
type AttemptOf<R, E> = Attempt<R, E>
type TryOptionsOf<R, E> = TryOptions<R, E>

/**
 * Either a success holding a value, or a failure holding an error.
 */
export type Result<T, E> = Ok<T> | Err<E>

export declare namespace Result {
  /**
   * Successful outcome.
   */
  type Ok<T> = OkOf<T>
  /**
   * Failed outcome.
   */
  type Err<E> = ErrOf<E>
  /**
   * Any Result.
   */
  type Any = AnyResult
  /**
   * Value type of a Result (distributive).
   */
  type ValueOf<R> = ValueOfAlias<R>
  /**
   * Error type of a Result (distributive).
   */
  type ErrorOf<R> = ErrorOfResult<R>
  /**
   * What `Result.try(fn)` returns.
   */
  type Attempt<R, E> = AttemptOf<R, E>
  /**
   * Options of `Result.try()` to build your own error.
   */
  type TryOptions<R, E> = TryOptionsOf<R, E>
}

/**
 * Build, inspect and combine Results.
 */
export const Result: {
  readonly ok: typeof ok
  readonly err: typeof err
  readonly is: typeof isResult
  readonly match: typeof match
  readonly try: typeof attempt
  readonly all: typeof all
  readonly partition: typeof partition
  readonly unwrap: typeof unwrap
  readonly unwrapErr: typeof unwrapErr
} = Object.freeze({
  ok,
  err,
  is: isResult,
  match,
  try: attempt,
  all,
  partition,
  unwrap,
  unwrapErr,
})
