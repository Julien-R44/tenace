export type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false

/**
 * Compile-time assertion: `expectType<Equal<A, B>>()`.
 */
export function expectType<T extends true>(): T | void {}

/**
 * Asserts that a value is assignable to `T`.
 */
export function assertType<T>(value: T): T {
  return value
}
