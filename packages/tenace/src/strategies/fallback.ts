import type { Context, ExecutionContext } from '../context.ts'
import type { GuardedTags, HandlerError, ValueOfReturn } from '../fold.ts'
import { type AnyResult, err } from '../result.ts'
import { toResult } from '../result_registry.ts'
import { type Next, Strategy } from '../strategy.ts'

export type FallbackHandler<R = unknown> = (error: never, context: Context) => R

/**
 * Errors removed by a `when` type guard, by tag, as in `withFallbackWhen()`. A plain
 * predicate guarantees nothing.
 */
type Guarded<When> = When extends ((error: unknown) => error is infer X)
  ? unknown extends X
    ? unknown
    : GuardedTags<X>
  : never

type Always = (error: unknown) => error is unknown

/**
 * Replaces errors matched by `when` with what `handler` returns: a value, an `ok()` /
 * `err()` Result, or a registered foreign Result (sync or async).
 *
 * Not run when the signal is aborted. The handler must not throw: a throw is a bug and
 * rejects the execution. Return `err(...)` to fail on purpose.
 *
 * Typed versions: `.withFallback()`, `.withFallbackOn()`, `.withFallbackWhen()`. Used with
 * `.with()`, only a type guard `when` removes errors from the channel.
 */
export class Fallback<
  R = unknown,
  When extends (error: unknown) => boolean = Always,
> extends Strategy<HandlerError<Awaited<R>>, Guarded<When>, ValueOfReturn<Awaited<R>>> {
  readonly name = 'fallback'
  readonly #handler: FallbackHandler<R>
  readonly #when: (error: unknown) => boolean

  constructor(handler: FallbackHandler<R>, when?: When) {
    super()
    this.#handler = handler
    this.#when = when ?? (() => true)
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    const result = await next(context)
    if (result.ok || context.signal.aborted || !this.#when(result.error)) return result
    context.emit({ type: 'fallback.used', error: result.error })
    return toResult(await this.#handler(result.error as never, context))
  }
}

/**
 * Matches errors by `_tag`.
 */
export function byTags(tags: readonly string[]): (error: unknown) => boolean {
  return error => tags.includes((error as { _tag?: unknown } | null)?._tag as string)
}

/**
 * Transforms every error. The mapper must not throw.
 */
export class MapError<E = unknown> extends Strategy<E, unknown> {
  readonly name = 'mapError'
  readonly #mapper: (error: never) => E

  constructor(mapper: (error: never) => E) {
    super()
    this.#mapper = mapper
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    const result = await next(context)
    return result.ok ? result : err(this.#mapper(result.error as never))
  }
}
