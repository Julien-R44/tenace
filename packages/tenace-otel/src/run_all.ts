/**
 * Runs every telemetry call even when one throws (a buggy span processor, exporter or
 * meter), so spans are always ended and metrics recorded. The first error is rethrown
 * afterwards: Tenace reports it without changing the outcome of the execution.
 */
export function runAll(...steps: ReadonlyArray<() => unknown>): void {
  let failure: { error: unknown } | undefined
  for (const step of steps) {
    try {
      step()
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure) throw failure.error
}
