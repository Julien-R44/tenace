import type { UnexpectedError } from './errors.ts'
import type { Result } from './result/namespace.ts'
import type { ResultTypes } from './result/registry.ts'
import type { AnyOp, Op } from './strategy.ts'

type Step<E, O> =
  O extends Op<infer Adds, infer Removes> ? Exclude<E, Removes> | Passed<Adds, E> : never

/**
 * A callback that passes an undeclared error along (`error => cond ? mapped : error`)
 * returns `OtherError`, which then stands for any error of the incoming union.
 */
type Passed<Adds, E> = Adds extends OtherError ? E : Adds

/**
 * Applies the ops of a policy, innermost first, to an error union. Ops that are not a
 * tuple (`AnyPolicy`) can produce anything: `unknown`.
 */
export type Fold<E, Ops extends readonly AnyOp[]> = Ops extends readonly [
  infer Head,
  ...infer Rest extends readonly AnyOp[],
]
  ? Fold<Step<E, Head>, Rest>
  : Ops extends readonly []
    ? E
    : unknown

declare const OTHER: unique symbol

/**
 * Stands for the errors a reusable policy did not declare. Callbacks can pass it along but
 * cannot inspect or narrow it. Declare errors with `Tenace.policy<MyError>()`, or bind the
 * function with `Tenace.call(fn)`, to make them visible.
 */
export interface OtherError {
  readonly [OTHER]: true
  /**
   * Lets `error._tag === 'Known'` narrow a union that contains undeclared errors.
   */
  readonly _tag?: undefined
}

type IsAny<T> = 0 extends 1 & T ? true : false
type Foreign<R> = ResultTypes<R>[Exclude<keyof ResultTypes<R>, '~input'>]

type MemberValue<R> =
  R extends Result.Ok<infer T>
    ? T
    : R extends Result.Err<unknown>
      ? never
      : [Foreign<R>] extends [never]
        ? R
        : Foreign<R> extends readonly [infer T, unknown]
          ? T
          : never

type MemberError<R> =
  R extends Result.Err<infer E>
    ? E
    : R extends Result.Ok<unknown>
      ? never
      : [Foreign<R>] extends [never]
        ? never
        : Foreign<R> extends readonly [unknown, infer E]
          ? E
          : never

/**
 * Success value of what a function returned (Results and registered foreign Results unwrapped).
 */
export type ValueOfReturn<R> =
  IsAny<R> extends true ? R : R extends unknown ? MemberValue<R> : never

/**
 * Errors contributed by what a function returned. Thrown values are always `UnexpectedError`.
 * An `unknown` return may be any `Result.err(...)`: `unknown`. An `any` return (parsed JSON) is a
 * value, not a Result.
 */
export type ErrorOfReturn<R> =
  IsAny<R> extends true
    ? UnexpectedError
    : unknown extends R
      ? unknown
      : (R extends unknown ? MemberError<R> : never) | UnexpectedError

/**
 * Errors returned (not thrown) by a handler, such as a fallback returning `Result.err(...)`.
 * An `unknown` return may be any `Result.err(...)`: `unknown`. An `any` return is a value.
 */
export type HandlerError<R> =
  IsAny<R> extends true
    ? never
    : unknown extends R
      ? unknown
      : R extends unknown
        ? MemberError<R>
        : never

type LiteralTag<X> = X extends { readonly _tag: infer K extends string }
  ? string extends K
    ? never
    : K
  : never

/**
 * Errors a type guard removes from the channel: the guarded type itself, only when every
 * member it guards has a literal `_tag`. Errors with another tag (such as `UnexpectedError`)
 * can then never match it. Untagged classes match structurally, which proves nothing about
 * what the guard accepts at runtime, so they remove nothing.
 *
 * Types are compared by structure: a subclass that adds nothing to its parent is the same
 * type, so a guard on it removes the parent too, although `instanceof` does not match the
 * parent at runtime. A guarded subclass needs its own `_tag` or a member of its own.
 */
export type GuardedTags<X> = [X] extends [{ readonly _tag: LiteralTag<X> }] ? X : never
