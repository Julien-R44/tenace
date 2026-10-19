import { type Meter, metrics, SpanKind, trace, type Tracer } from '@opentelemetry/api'
import type { Instrumentation } from '@julr/tenace'

import { ExecutionRecorder } from './execution_recorder.ts'
import { instrumentsOf } from './instruments.ts'

const SCOPE = '@julr/tenace'

export interface OpenTelemetryOptions {
  /**
   * Defaults to `trace.getTracer('@julr/tenace')`, looked up on each execution.
   */
  readonly tracer?: Tracer | undefined
  /**
   * Defaults to `metrics.getMeter('@julr/tenace')`, looked up on each execution so a meter
   * provider registered later is used.
   */
  readonly meter?: Meter | undefined
  /**
   * Record a span event for each Tenace event. Defaults to `true`.
   */
  readonly spanEvents?: boolean | undefined
}

/**
 * OpenTelemetry instrumentation for Tenace:
 * - one INTERNAL span per execution, named after the operation, and one child span per
 *   attempt (active while the function runs, so your HTTP/DB spans nest under it),
 * - errors handled by a retry or a fallback mark the attempt span only, the execution span
 *   gets `error.type` and an ERROR status on final failure only,
 * - attempts still running when the execution ends (after a timeout) are ended with it and
 *   marked `tenace.attempt.abandoned`,
 * - span events for retries, timeouts, circuit and bulkhead rejections, fallbacks,
 * - metrics `tenace.execution.duration`, `tenace.attempt.duration` (seconds),
 *   `tenace.execution.attempts`, `tenace.events` and `tenace.circuit_breaker.state`.
 *
 * Without explicit `tracer` and `meter`, the global providers are looked up on each
 * execution, so `openTelemetry()` may be called before the SDK starts.
 *
 * ```ts
 * Tenace.instrument(openTelemetry({ tracer, meter }))
 * ```
 */
export function openTelemetry(options: OpenTelemetryOptions = {}): Instrumentation {
  const spanEvents = options.spanEvents ?? true

  return {
    execution(info, run) {
      const tracer = options.tracer ?? trace.getTracer(SCOPE)
      const instruments = instrumentsOf(options.meter ?? metrics.getMeter(SCOPE))
      const spanOptions = {
        kind: SpanKind.INTERNAL,
        attributes: {
          ...info.attributes,
          'tenace.operation.name': info.name,
          'tenace.strategies': info.strategies.join(','),
        },
      }

      return tracer.startActiveSpan(info.name, spanOptions, async root => {
        const recorder = new ExecutionRecorder({
          name: info.name,
          root,
          tracer,
          instruments,
          spanEvents,
        })
        let failure: { error: unknown } | undefined
        try {
          const result = await run(recorder)
          if (!result.ok) failure = { error: result.error }
          return result
        } catch (error) {
          failure = { error }
          throw error
        } finally {
          recorder.end(failure)
        }
      })
    },
  }
}
