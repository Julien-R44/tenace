import type { Clock } from './clock.ts'
import type { Context } from './context.ts'
import { linkSignal } from './internal/signal.ts'
import type { AnyPolicy, Fn } from './policy.ts'
import type { AnyResult } from './result.ts'

export interface BatchOptions<P> {
  /**
   * Policy every task runs through. Defaults to an empty policy.
   */
  readonly policy?: P
  /**
   * Tasks running at the same time. Defaults to all of them.
   */
  readonly concurrency?: number
}

export interface BatchRunOptions {
  /**
   * Aborting it aborts every task: the batch rejects with `signal.reason`.
   */
  readonly signal?: AbortSignal
  readonly clock?: Clock
}

type Runner = (task: Fn, options: { signal: AbortSignal; clock?: Clock }) => Promise<unknown>

/**
 * A set of tasks run through the same policy, with bounded concurrency.
 *
 * - `execute()` is fail-fast: it rejects with the first failure (like `policy.execute()`),
 *   aborts the signal of running tasks and skips the ones not started yet.
 * - `settle()` runs every task and resolves with one typed Result per task, in order.
 */
export class Batch<Values extends readonly unknown[], Results extends readonly unknown[]> {
  readonly #tasks: readonly Fn[]
  readonly #policy: AnyPolicy
  readonly #concurrency: number

  /**
   * @internal Use `Tenace.all()` or `Tenace.map()`.
   */
  constructor(tasks: readonly Fn[], policy: AnyPolicy, concurrency: number) {
    if (
      !(
        concurrency === Number.POSITIVE_INFINITY ||
        (Number.isInteger(concurrency) && concurrency >= 1)
      )
    ) {
      throw new RangeError(`Invalid concurrency: ${concurrency}. Expected an integer >= 1`)
    }
    this.#tasks = tasks
    this.#policy = policy
    this.#concurrency = concurrency
  }

  async execute(options: BatchRunOptions = {}): Promise<Values> {
    const policy = this.#policy as unknown as { execute(fn: Fn, options: object): Promise<unknown> }
    return (await this.#run(options, true, (task, runOptions) =>
      policy.execute(task, runOptions),
    )) as never
  }

  async settle(options: BatchRunOptions = {}): Promise<Results> {
    const policy = this.#policy as unknown as {
      settle(fn: Fn, options: object): Promise<AnyResult>
    }
    return (await this.#run(options, false, (task, runOptions) =>
      policy.settle(task, runOptions),
    )) as never
  }

  #run(options: BatchRunOptions, failFast: boolean, runner: Runner): Promise<unknown[]> {
    options.signal?.throwIfAborted()
    const tasks = this.#tasks
    const link = linkSignal(options.signal)
    const runOptions = { signal: link.signal, ...(options.clock && { clock: options.clock }) }
    const outputs: unknown[] = Array.from({ length: tasks.length })
    let failed = false

    return new Promise<unknown[]>((resolve, reject) => {
      let remaining = tasks.length
      let nextIndex = 0
      const onAbort = (): void => fail(options.signal!.reason)
      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', onAbort)
        link.dispose()
      }
      const finish = (): void => {
        cleanup()
        resolve(outputs)
      }
      const fail = (error: unknown): void => {
        if (failed) return
        failed = true
        link.abort(new DOMException('A sibling task of the batch failed', 'AbortError'))
        cleanup()
        reject(error)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      if (remaining === 0) return finish()

      // `concurrency` workers pulling the next task: the cost per task stays constant
      const work = async (): Promise<void> => {
        while (!failed && nextIndex < tasks.length) {
          const index = nextIndex++
          try {
            outputs[index] = await runner(tasks[index]!, runOptions)
            if (--remaining === 0 && !failed) finish()
          } catch (error) {
            if (failFast || !link.signal.aborted) fail(error)
          }
        }
      }
      const workers = Math.min(this.#concurrency, tasks.length)
      for (let i = 0; i < workers; i++) void work()
    })
  }
}

/**
 * Builds the tasks of `Tenace.map()`.
 */
export function mapTasks<T>(
  items: Iterable<T>,
  fn: (item: T, context: Context, index: number) => unknown,
): Fn[] {
  return Array.from(items, (item, index) => (context: Context) => fn(item, context, index))
}
