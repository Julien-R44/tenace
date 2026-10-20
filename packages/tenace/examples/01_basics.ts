/**
 * Timeout per attempt, retries with backoff, then execute() or settle().
 * Run: node --conditions=tenace-source --import=@poppinss/ts-exec examples/01_basics.ts
 */
import { backoff, Result, Tenace } from '@julr/tenace'

let calls = 0
async function fetchProfile({ signal }: { signal: AbortSignal }): Promise<{ name: string }> {
  calls++
  if (calls < 3) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1000)
      signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)))
    })
  }
  return { name: 'Julien' }
}

const policy = Tenace.policy({ name: 'profile.get' })
  .withTimeout('100ms')
  .withRetry({
    retries: 3,
    delay: backoff.exponential({ base: '50ms' }),
    retryOn: ['TimeoutError'],
  })

// execute(): resolves with the value or rejects
const profile = await policy.execute(fetchProfile)
console.log('execute:', profile, `(${calls} calls)`)

// settle(): a typed Result, never rejects for the errors in the channel
calls = 0
const result = await policy.settle(fetchProfile)
console.log(
  'settle:',
  Result.match(result, {
    ok: value => `hello ${value.name}`,
    TimeoutError: error => `timed out after ${error.timeoutMs}ms`,
    UnexpectedError: error => `failed: ${String(error.cause)}`,
  }),
)
