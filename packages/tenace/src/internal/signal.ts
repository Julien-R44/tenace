export interface LinkedSignal {
  readonly signal: AbortSignal
  abort(reason: unknown): void
  /**
   * Stops following the parent. Call it once the child is no longer needed, so long-lived
   * parent signals do not retain listeners.
   */
  dispose(): void
}

const noop = (): void => {}

/**
 * A child signal aborted when the parent aborts (with the parent reason) or when
 * `abort()` is called. Without a parent, only `abort()` aborts it.
 */
export function linkSignal(parent: AbortSignal | undefined): LinkedSignal {
  const controller = new AbortController()
  if (!parent) {
    return { signal: controller.signal, abort: reason => controller.abort(reason), dispose: noop }
  }
  const onParentAbort = (): void => controller.abort(parent.reason)

  if (parent.aborted) controller.abort(parent.reason)
  else parent.addEventListener('abort', onParentAbort, { once: true })

  return {
    signal: controller.signal,
    abort: reason => controller.abort(reason),
    dispose: () => parent.removeEventListener('abort', onParentAbort),
  }
}
