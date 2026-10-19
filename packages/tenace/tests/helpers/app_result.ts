/**
 * A homemade Result type, like the ones users already have in their apps.
 */
export class AppOk<T> {
  readonly success = true as const
  readonly data: T

  constructor(data: T) {
    this.data = data
  }
}

export class AppErr<E> {
  readonly success = false as const
  readonly failure: E

  constructor(failure: E) {
    this.failure = failure
  }
}

export type AppResult<T, E> = AppOk<T> | AppErr<E>

declare module '../../src/index.ts' {
  interface ResultTypes<R> {
    app: R extends AppOk<infer T> ? [T, never] : R extends AppErr<infer E> ? [never, E] : never
  }
}
