import type { ExecutionContext } from '../../src/context.ts'
import { TenaceError } from '../../src/errors.ts'
import { Result } from '../../src/result/namespace.ts'
import { type Next, Strategy } from '../../src/strategy.ts'

export class BoomError extends TenaceError {
  static readonly tag = 'BoomError'
  readonly _tag = 'BoomError' as const
  readonly code = 'E_BOOM' as const
}

export class NotFound extends TenaceError {
  static readonly tag = 'NotFound'
  readonly _tag = 'NotFound' as const
  readonly code = 'E_NOT_FOUND' as const
}

/**
 * Records when it enters and leaves, to observe the nesting order.
 */
export class Trace extends Strategy {
  readonly name: string
  readonly log: string[]

  constructor(name: string, log: string[]) {
    super()
    this.name = name
    this.log = log
  }

  async execute(context: ExecutionContext, next: Next): Promise<Result.Any> {
    this.log.push(`${this.name}:in`)
    const result = await next(context)
    this.log.push(`${this.name}:out`)
    return result
  }
}

/**
 * Turns a successful inner result into a BoomError (adds BoomError).
 */
export class Explode extends Strategy<BoomError> {
  readonly name = 'explode'

  async execute(context: ExecutionContext, next: Next): Promise<Result.Any> {
    const result = await next(context)
    return result.ok ? Result.err(new BoomError('boom')) : result
  }
}

/**
 * Replaces any error by a fixed value (removes every error, adds the value).
 */
export class Rescue<const V> extends Strategy<never, unknown, V> {
  readonly name = 'rescue'
  readonly value: V

  constructor(value: V) {
    super()
    this.value = value
  }

  async execute(context: ExecutionContext, next: Next): Promise<Result.Any> {
    const result = await next(context)
    return result.ok ? result : Result.ok(this.value)
  }
}

/**
 * Stateful: counts calls across every policy it was added to.
 */
export class Counter extends Strategy {
  readonly name = 'counter'
  calls = 0

  execute(context: ExecutionContext, next: Next): Promise<Result.Any> {
    this.calls++
    return next(context)
  }
}

/**
 * Runs the inner steps twice, with attempt 1 then 2, and returns the last result.
 */
export class Twice extends Strategy {
  readonly name = 'twice'

  async execute(context: ExecutionContext, next: Next): Promise<Result.Any> {
    await next(context)
    return next(context.with({ attempt: context.attempt + 1 }))
  }
}
