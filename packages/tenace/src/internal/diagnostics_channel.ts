import type {
  ExecutionInfo,
  ExecutionScope,
  Instrumentation,
  TenaceEvent,
} from '../instrumentation.ts'
import type { Result } from '../result/namespace.ts'

/**
 * Message of the `tracing:tenace:execution:*` channels. `result` is the final Tenace Result.
 */
export interface ExecutionMessage extends ExecutionInfo {
  result?: Result.Any
  error?: unknown
  [key: symbol]: unknown
}

/**
 * Message of the `tracing:tenace:attempt:*` channels. `result` is the attempt Result.
 */
export interface AttemptMessage {
  readonly execution: ExecutionMessage
  readonly attempt: number
  result?: Result.Any
  error?: unknown
  [key: symbol]: unknown
}

/**
 * Message of the `tenace:event` channel.
 */
export interface EventMessage {
  readonly execution: ExecutionMessage
  readonly event: TenaceEvent
}

interface SubChannel {
  readonly hasSubscribers: boolean
}
interface TracingChannel<M> {
  readonly start: SubChannel
  readonly end: SubChannel
  readonly asyncStart: SubChannel
  readonly asyncEnd: SubChannel
  readonly error: SubChannel
  tracePromise<T>(fn: () => Promise<T>, context: M): Promise<T>
}
interface Channel extends SubChannel {
  publish(message: unknown): void
}
interface DiagnosticsChannelModule {
  tracingChannel<M>(name: string): TracingChannel<M>
  channel(name: string): Channel
}

export interface DiagnosticsChannelInstrumentation extends Instrumentation {
  /**
   * Whether anything subscribed to a Tenace channel.
   */
  isActive(): boolean
}

function load(): DiagnosticsChannelModule | undefined {
  try {
    const process = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
      .process
    const dc = process?.getBuiltinModule?.('node:diagnostics_channel') as
      | DiagnosticsChannelModule
      | undefined
    return typeof dc?.tracingChannel === 'function' ? dc : undefined
  } catch {
    return undefined
  }
}

const active = (channel: TracingChannel<never>): boolean =>
  channel.start.hasSubscribers ||
  channel.end.hasSubscribers ||
  channel.asyncStart.hasSubscribers ||
  channel.asyncEnd.hasSubscribers ||
  channel.error.hasSubscribers

let cached: DiagnosticsChannelInstrumentation | null | undefined

/**
 * Publishes executions, attempts and events on `node:diagnostics_channel`, loaded lazily
 * (no static `node:` import, so bundles stay platform neutral). `undefined` when the
 * runtime has no diagnostics_channel.
 *
 * - `tracing:tenace:execution:*` with an `ExecutionMessage`
 * - `tracing:tenace:attempt:*` with an `AttemptMessage`
 * - `tenace:event` with an `EventMessage`
 */
export function diagnosticsChannel(): DiagnosticsChannelInstrumentation | undefined {
  if (cached !== undefined) return cached ?? undefined
  const dc = load()
  if (!dc) {
    cached = null
    return undefined
  }

  const execution = dc.tracingChannel<ExecutionMessage>('tenace:execution')
  const attempt = dc.tracingChannel<AttemptMessage>('tenace:attempt')
  const events = dc.channel('tenace:event')

  cached = {
    isActive: () =>
      active(execution as TracingChannel<never>) ||
      active(attempt as TracingChannel<never>) ||
      events.hasSubscribers,
    execution(
      info: ExecutionInfo,
      run: (scope: ExecutionScope) => Promise<Result.Any>,
    ): Promise<Result.Any> {
      const message: ExecutionMessage = { ...info }
      const scope: ExecutionScope = {
        attempt: (attemptInfo, fn) =>
          active(attempt as TracingChannel<never>)
            ? attempt.tracePromise(fn, { execution: message, attempt: attemptInfo.attempt })
            : fn(),
        event: event => {
          if (events.hasSubscribers)
            events.publish({ execution: message, event } satisfies EventMessage)
        },
      }
      return active(execution as TracingChannel<never>)
        ? execution.tracePromise(() => run(scope), message)
        : run(scope)
    },
  }
  return cached
}
