/**
 * Reports an error that must not change the result of an execution (an observer that
 * throws, a defect after a timeout won the race): with `globalThis.reportError` when
 * available, as an uncaught error otherwise, like `node:diagnostics_channel` subscribers.
 */
export function reportError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError
  if (report) report(error)
  else
    queueMicrotask(() => {
      throw error
    })
}
