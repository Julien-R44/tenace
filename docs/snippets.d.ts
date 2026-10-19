/**
 * Application code the documentation snippets call. Declared once here so the snippets
 * stay short and still typecheck. A snippet that defines one of these names shadows it.
 */
import type { Context, Result, TenaceError } from '@julr/tenace'

declare global {
  interface User {
    readonly id: string
    readonly name: string
  }
  interface Post {
    readonly id: string
    readonly title: string
  }

  class HttpError extends TenaceError {
    readonly _tag: 'HttpError'
    readonly code: 'E_HTTP'
    readonly status: number
    constructor(status: number)
  }

  const id: string
  const logger: {
    debug(value: unknown): void
    info(value: unknown): void
  }
  const ids: readonly string[]

  function fn(context: Context): Promise<string>
  function fetchUser(id: string, options?: { signal?: AbortSignal }): Promise<User>
  function getUser(id: string): Promise<User>
  function getPosts(userId: string): Promise<Post[]>
  function fetchProfile(context: Context): Promise<{ name: string }>
  function request(path: string): Promise<Result<string, HttpError>>
}

export {}
