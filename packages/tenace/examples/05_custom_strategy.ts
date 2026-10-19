/**
 * A custom strategy: declare what it adds to the error channel, return Results.
 * Run: node --conditions=tenace-source --import=@poppinss/ts-exec examples/05_custom_strategy.ts
 */
import {
  type AnyResult,
  err,
  type ExecutionContext,
  listener,
  type Next,
  Strategy,
  Tenace,
  TenaceError,
} from '@julr/tenace'

class QuotaExceeded extends TenaceError {
  readonly _tag = 'QuotaExceeded' as const
  readonly code = 'E_QUOTA_EXCEEDED' as const
}

/**
 * Allows `max` calls in total, then fails with QuotaExceeded.
 */
class Quota extends Strategy<QuotaExceeded> {
  readonly name = 'quota'
  #used = 0
  readonly #max: number

  constructor(max: number) {
    super()
    this.#max = max
  }

  async execute(context: ExecutionContext, next: Next): Promise<AnyResult> {
    if (this.#used >= this.#max) {
      context.emit({ type: 'custom', name: 'quota.exceeded', attributes: { max: this.#max } })
      return err(new QuotaExceeded(`quota of ${this.#max} calls exceeded`))
    }
    this.#used++
    return next(context)
  }
}

const policy = Tenace.policy({
  instrumentation: listener(event => console.log('event:', event.type)),
})
  .with(new Quota(2))
  .withFallbackOn(['QuotaExceeded'], error => `fallback (${error.message})`)

for (let i = 0; i < 3; i++) console.log(await policy.execute(() => `call ${i}`))
