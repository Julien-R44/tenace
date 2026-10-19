import type { BulkheadFullError, UnexpectedError } from '../../src/errors.ts'
import type { ErrorOf } from '../../src/policy.ts'
import { Bulkhead } from '../../src/strategies/bulkhead.ts'
import { Tenace } from '../../src/tenace.ts'
import { type Equal, expectType } from './helpers.ts'

const policy = Tenace.policy().with(new Bulkhead({ concurrency: 2 }))
expectType<Equal<ErrorOf<typeof policy>, UnexpectedError | BulkheadFullError>>()
const sugar = Tenace.policy().withBulkhead({ concurrency: 2, queue: 10, maxWait: '1s' })
expectType<Equal<ErrorOf<typeof sugar>, UnexpectedError | BulkheadFullError>>()
