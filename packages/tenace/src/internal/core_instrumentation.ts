import {
  type ExecutionInfo,
  type ExecutionScope,
  type Instrumentation,
  noopScope,
} from '../instrumentation.ts'
import type { AnyResult } from '../result/core.ts'
import { reportError } from './report_error.ts'

type Outcome =
  | { readonly ok: true; readonly value: AnyResult }
  | { readonly ok: false; readonly error: unknown }

function invoke<A>(fn: (arg: A) => Promise<AnyResult>, arg: A): Promise<AnyResult> {
  try {
    return Promise.resolve(fn(arg))
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * Runs `inner` through a user hook (`execution` or `attempt` of an instrumentation), so a
 * buggy hook cannot change what the caller gets:
 * - `inner` runs at most once: calling `proceed` again rejects without running it,
 * - the outcome is always the one of `inner`, whatever the hook returns,
 * - errors of the hook are reported with `reportError()`, unless it forwards the rejection
 *   of `inner`,
 * - a hook that settles without calling `proceed` is reported, then `inner` runs without
 *   it (with `fallback`). A hook that never settles still blocks the execution.
 */
async function enforce<A>(
  hook: (proceed: (arg: A) => Promise<AnyResult>) => unknown,
  inner: (arg: A) => Promise<AnyResult>,
  fallback: A,
): Promise<AnyResult> {
  const state: { outcome?: Promise<Outcome>; failure?: { error: unknown } | undefined } = {}
  const refused: unknown[] = []
  const proceed = (arg: A): Promise<AnyResult> => {
    if (state.outcome) {
      const error = new TypeError('Tenace: an instrumentation called run() more than once')
      refused.push(error)
      reportError(error)
      const rejected = Promise.reject(error)
      // already reported: a hook ignoring this promise must not report it again
      void rejected.catch(() => {})
      return rejected
    }
    const promise = invoke(inner, arg)
    state.outcome = promise.then(
      value => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    )
    return promise
  }

  try {
    await hook(proceed)
  } catch (error) {
    state.failure = { error }
  }

  if (!state.outcome) {
    reportError(
      state.failure
        ? state.failure.error
        : new TypeError('Tenace: an instrumentation settled without calling run()'),
    )
    state.failure = undefined
    void proceed(fallback)
  }

  const outcome = await state.outcome!
  const failure = state.failure
  if (failure && !refused.includes(failure.error)) {
    if (outcome.ok || outcome.error !== failure.error) reportError(failure.error)
  }
  if (outcome.ok) return outcome.value
  throw outcome.error
}

function guardScope(scope: ExecutionScope, isDone: () => boolean): ExecutionScope {
  if (scope === noopScope) return noopScope
  return {
    attempt: (info, fn) =>
      // a shared run (dedupe) can outlive the execution: no hook under a settled span
      isDone()
        ? fn()
        : enforce(
            proceed => scope.attempt(info, () => proceed(undefined)),
            () => fn(),
            undefined,
          ),
    event: event => {
      if (isDone()) return
      try {
        scope.event(event)
      } catch (error) {
        reportError(error)
      }
    },
  }
}

function observe(
  instrumentation: Instrumentation,
  info: ExecutionInfo,
  run: (scope: ExecutionScope) => Promise<AnyResult>,
): Promise<AnyResult> {
  let done = false
  const finish = (): void => {
    done = true
  }
  return enforce(
    proceed => instrumentation.execution(info, proceed),
    scope => {
      const promise = invoke(
        run,
        guardScope(scope, () => done),
      )
      promise.then(finish, finish)
      return promise
    },
    noopScope,
  )
}

const guarded = new WeakMap<Instrumentation, Instrumentation>()

/**
 * Enforces the instrumentation contract, so instrumentation bugs never change the outcome
 * of an execution (see `enforce`). Scope hooks are guarded too: an `attempt` hook follows
 * the same rules, an `event` handler that throws is reported and does not reach the
 * strategies, and events and attempt hooks once the execution settled are skipped.
 */
export function guardInstrumentation(instrumentation: Instrumentation): Instrumentation {
  let guard = guarded.get(instrumentation)
  if (!guard) {
    guard = { execution: (info, run) => observe(instrumentation, info, run) }
    guarded.set(instrumentation, guard)
  }
  return guard
}
