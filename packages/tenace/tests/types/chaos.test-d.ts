import { TenaceError, type UnexpectedError } from '../../src/errors.ts'
import type { ErrorOf } from '../../src/policy.ts'
import type { Result } from '../../src/result.ts'
import { Tenace } from '../../src/tenace.ts'
import { type Equal, expectType } from './helpers.ts'

class Injected extends TenaceError {
  readonly _tag = 'Injected' as const
  readonly code = 'E_INJECTED' as const
}

const latency = Tenace.policy().withChaos({ latency: '1s', rate: 0.1 })
expectType<Equal<ErrorOf<typeof latency>, UnexpectedError>>()

const typed = Tenace.policy().withChaos({ error: () => new Injected('x') })
expectType<Equal<ErrorOf<typeof typed>, UnexpectedError | Injected>>()

const canned = await Tenace.policy()
  .withChaos({ value: () => 'canned' as const })
  .settle(() => 1)
expectType<Equal<typeof canned, Result<number | 'canned', UnexpectedError>>>()

// @ts-expect-error global chaos cannot inject typed errors
Tenace.chaos({ error: () => new Injected('x') })
