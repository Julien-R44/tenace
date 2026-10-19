import type { Result } from './result.ts'
import type { ByTag, TagOf } from './types.ts'

type Cases<T, E> = { readonly ok: (value: T) => unknown } & {
  readonly [K in TagOf<E>]?: (error: ByTag<E, K>) => unknown
} & { readonly _?: (error: E) => unknown }

/**
 * Without `_`, every tag of E must have a handler, and E must not have untagged members.
 */
type Exhaustive<E, H> = H extends { readonly _: unknown }
  ? unknown
  : { readonly [K in Exclude<TagOf<E>, keyof H>]: (error: ByTag<E, K>) => unknown } & ([
      Exclude<E, { readonly _tag: string }>,
    ] extends [never]
      ? unknown
      : { readonly _: (error: E) => unknown })

/**
 * Rejects handlers for tags that are not part of E (generic inference skips excess property checks).
 */
type NoExtraKeys<E, H> = {
  readonly [K in Exclude<keyof H, 'ok' | '_' | TagOf<E>>]: never
}

type Output<H> = {
  [K in keyof H]: H[K] extends (...args: never[]) => infer R ? R : never
}[keyof H]

/**
 * Pattern match a Result: `ok` plus one handler per error `_tag`.
 *
 * Exhaustive by default. `_` handles every remaining error, and is required when the error
 * type has untagged members (strings, plain `Error`s, `unknown`). An error without a matching
 * handler (only possible with untyped input) is rethrown.
 *
 * ```ts
 * const view = match(result, {
 *   ok: user => render(user),
 *   TimeoutError: () => retryLater(),
 *   _: error => fail(error),
 * })
 * ```
 */
export function match<T, E, const H extends Cases<T, E> & NoExtraKeys<E, H>>(
  result: Result<T, E>,
  cases: H & Exhaustive<E, H>,
): Output<H> {
  const handlers = cases as unknown as Record<string, ((input: unknown) => unknown) | undefined>
  if (result.ok) return handlers['ok']!(result.value) as Output<H>

  const tag = (result.error as { _tag?: unknown } | null | undefined)?._tag
  const own = typeof tag === 'string' && tag !== 'ok' && Object.hasOwn(handlers, tag)
  const handler = (own ? handlers[tag as string] : undefined) ?? handlers['_']
  if (!handler) throw result.error
  return handler(result.error) as Output<H>
}
