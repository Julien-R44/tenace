/**
 * Batches: bounded concurrency, fail-fast execute() or one Result per item with settle().
 * Run: node --conditions=tenace-source --import=@poppinss/ts-exec examples/04_batch.ts
 */
import { Result, Tenace } from '@julr/tenace'

const policy = Tenace.policy().withTimeout('500ms').withRetry({ retries: 1, delay: 10 })

const ids = ['1', '2', '3', '4', '5']
const users = await Tenace.map(ids, async id => ({ id }), { policy, concurrency: 2 }).execute()
console.log('users:', users)

const results = await Tenace.map(ids, id => (id === '3' ? Result.err('nope') : id), {
  policy,
}).settle()
console.log(
  'settled:',
  results.map(result => (result.ok ? result.value : `error ${String(result.error)}`)),
)

const [user, posts] = await Tenace.all([async () => ({ id: '1' }), async () => ['hello']], {
  policy,
}).execute()
console.log('all:', user, posts)
