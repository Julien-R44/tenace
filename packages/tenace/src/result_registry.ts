import { type AnyResult, isResult, ok } from './result.ts'

/**
 * Registry of foreign Result types, so a function returning your own Result type
 * contributes its value and error types. Augment it once per Result library:
 *
 * ```ts
 * declare module '@julr/tenace' {
 *   interface ResultTypes<R> {
 *     neverthrow: R extends Ok<infer T, unknown> ? [T, never] : R extends Err<unknown, infer E> ? [never, E] : never
 *   }
 * }
 * ```
 *
 * Each entry maps one member of the returned union to a `[value, error]` tuple, or `never`
 * when the member is not one of its results. Pair it with `registerResult()` at runtime.
 */
export interface ResultTypes<R> {
  /**
   * Reserved, keeps `R` in use. Not a registry entry.
   */
  readonly '~input'?: R
}

/**
 * Names declared in `ResultTypes`.
 */
export type ResultTypeName = Extract<Exclude<keyof ResultTypes<unknown>, '~input'>, string>

/**
 * Converts a foreign value to a Tenace Result, or returns `undefined` when the value is
 * not one of its results.
 */
export type ResultAdapter = (value: unknown) => AnyResult | undefined

const REGISTRY_KEY: unique symbol = Symbol.for('@julr/tenace/result-adapters') as never
const registry = globalThis as { [REGISTRY_KEY]?: Map<string, ResultAdapter> }
const adapters: Map<string, ResultAdapter> = (registry[REGISTRY_KEY] ??= new Map())

/**
 * Runtime half of the `ResultTypes` registry. `name` must be declared in `ResultTypes`.
 * Registering the same name again replaces the adapter.
 *
 * ```ts
 * registerResult('neverthrow', value =>
 *   value instanceof Ok ? Result.ok(value.value) : value instanceof Err ? Result.err(value.error) : undefined,
 * )
 * ```
 */
export function registerResult(name: ResultTypeName, adapter: ResultAdapter): void {
  adapters.set(name, adapter)
}

/**
 * Removes a registered adapter. Mostly useful in tests.
 */
export function unregisterResult(name: ResultTypeName): void {
  adapters.delete(name)
}

/**
 * @internal Normalizes what a user function returned.
 */
export function toResult(value: unknown): AnyResult {
  if (isResult(value)) return value
  for (const adapter of adapters.values()) {
    const converted = adapter(value)
    if (converted !== undefined) return converted
  }
  return ok(value)
}
