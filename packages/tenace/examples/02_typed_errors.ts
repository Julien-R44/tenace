/**
 * Functions returning Results contribute their errors to the channel.
 * Run: node --conditions=tenace-source --import=@poppinss/ts-exec examples/02_typed_errors.ts
 */
import { err, ok, type Result, Tenace, TenaceError } from '@julr/tenace'

class NotFound extends TenaceError {
  readonly _tag = 'NotFound' as const
  readonly code = 'E_NOT_FOUND' as const
}

class HttpError extends TenaceError {
  readonly _tag = 'HttpError' as const
  readonly code = 'E_HTTP' as const
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

type User = { id: string; name: string }
let attempts = 0
async function findUser(id: string): Promise<Result<User, NotFound | HttpError>> {
  attempts++
  if (id === 'missing') return err(new NotFound(`user ${id}`))
  if (attempts < 2) return err(new HttpError(503))
  return ok({ id, name: 'Julien' })
}

// Tenace.call: callbacks see the exact errors of the function
const user = await Tenace.call(() => findUser('1'))
  .withTimeout('1s')
  .withRetry({
    retries: 2,
    delay: 10,
    retryIf: error => error._tag === 'HttpError' && error.status >= 500,
  })
  .withFallbackOn(['NotFound'], () => null)
  .settle()
console.log('user:', user)

// a reusable policy accepts any function, the result type stays exact
const users = Tenace.policy().withTimeout('1s')
const missing = await users.settle(() => findUser('missing'))
if (!missing.ok && missing.error instanceof NotFound)
  console.log('not found:', missing.error.message)

// execute() rejects with known errors as is: narrow them with isError()
try {
  await users.execute(() => findUser('missing'))
} catch (error) {
  if (users.isError(error)) console.log('known error:', error._tag)
}
