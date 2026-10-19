import {
  type Attributes,
  context,
  type Counter,
  type Histogram,
  type Meter,
  metrics,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api'
import {
  type AnyResult,
  type CircuitState,
  type Instrumentation,
  isTenaceError,
  type RetryEventCause,
  type TenaceEvent,
  UnexpectedError,
} from '@julr/tenace'

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

const STATE_VALUE: Record<CircuitState, number> = {
  'closed': 0,
  'open': 1,
  'half-open': 2,
  'isolated': 3,
}

/**
 * Low cardinality `error.type`, the type of the error (thrown values are unwrapped from
 * `UnexpectedError`):
 * - the `_tag` of Tenace errors and of any object with a string `_tag`,
 * - for an `Error`, its `name`, or its class name when `name` is the default `'Error'`
 *   (`class PaymentDeclined extends Error {}` gives `PaymentDeclined`),
 * - `_OTHER` otherwise.
 *
 * Never throws.
 */
export function errorType(error: unknown): string {
  try {
    if (error instanceof UnexpectedError) return errorType(error.cause)
    if (isTenaceError(error)) return error._tag
    if (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { _tag?: unknown })._tag === 'string'
    ) {
      return (error as { _tag: string })._tag
    }
    if (error instanceof Error) {
      if (typeof error.name === 'string' && error.name && error.name !== 'Error') {
        return error.name
      }
      const className: unknown = error.constructor?.name
      return typeof className === 'string' && className ? className : 'Error'
    }
  } catch {}
  return '_OTHER'
}

/**
 * Message of a thrown value. Never throws, even for null-prototype objects or a throwing
 * `toString()` (same logic as the message of `UnexpectedError`).
 */
function describe(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === 'string') return value.message
    return String(value)
  } catch {
    try {
      return Object.prototype.toString.call(value)
    } catch {
      return 'Unknown error'
    }
  }
}

/**
 * Runs every telemetry call even when one throws (a buggy span processor, exporter or
 * meter), so spans are always ended and metrics recorded. The first error is rethrown
 * afterwards: Tenace reports it without changing the outcome of the execution.
 */
function runAll(...steps: ReadonlyArray<() => unknown>): void {
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

function recordError(span: Span, error: unknown): void {
  const raw = error instanceof UnexpectedError ? error.cause : error
  const type = errorType(error)
  const message = describe(raw)
  runAll(
    () => span.setAttribute('error.type', type),
    () => span.recordException(raw instanceof Error ? raw : { name: type, message }),
    () => span.setStatus({ code: SpanStatusCode.ERROR, message }),
  )
}

/**
 * A retry caused by a value (`retryIfValue`) has no `error.type`.
 */
function retryCause(event: RetryEventCause): Attributes {
  return 'value' in event
    ? { 'tenace.retry.cause': 'value' }
    : { 'tenace.retry.cause': 'error', 'error.type': errorType(event.error) }
}

function eventAttributes(event: TenaceEvent): Attributes {
  switch (event.type) {
    case 'retry.scheduled':
      return {
        'tenace.attempt.number': event.attempt,
        'tenace.retry.delay_ms': event.delayMs,
        ...retryCause(event),
      }
    case 'retry.exhausted':
      return { 'tenace.attempts': event.attempts, ...retryCause(event) }
    case 'retry.declined':
      return {
        'tenace.attempt.number': event.attempt,
        'tenace.retry.declined_reason': event.reason,
        ...retryCause(event),
      }
    case 'timeout':
      return { 'tenace.attempt.number': event.attempt, 'tenace.timeout.ms': event.timeoutMs }
    case 'circuit.state_changed':
      return {
        'tenace.circuit_breaker.name': event.breaker,
        'tenace.circuit_breaker.from': event.from,
        'tenace.circuit_breaker.to': event.to,
      }
    case 'circuit.rejected':
      return {
        'tenace.circuit_breaker.name': event.breaker,
        'tenace.circuit_breaker.state': event.state,
        ...(event.retryAfterMs !== undefined && { 'tenace.retry_after_ms': event.retryAfterMs }),
      }
    case 'bulkhead.rejected':
      return {
        'tenace.bulkhead.name': event.bulkhead,
        'tenace.bulkhead.running': event.running,
        'tenace.bulkhead.queued': event.queued,
      }
    case 'fallback.used':
      return { 'error.type': errorType(event.error) }
    case 'fallback.stale':
      return { 'tenace.key': event.key, 'tenace.stale.age_ms': event.ageMs }
    case 'rate_limit.rejected':
      return {
        'tenace.key': event.key,
        ...(event.retryAfterMs !== undefined && { 'tenace.retry_after_ms': event.retryAfterMs }),
      }
    case 'lock.rejected':
    case 'dedupe.joined':
    case 'cache.hit':
    case 'cache.miss':
      return { 'tenace.key': event.key }
    case 'cache.stale':
    case 'cache.failed':
      return { 'tenace.key': event.key, 'error.type': errorType(event.error) }
    case 'custom':
      return { 'tenace.event.custom_name': event.name, ...event.attributes }
  }
}

function eventName(event: TenaceEvent): string {
  return event.type === 'custom' ? `tenace.custom.${event.name}` : `tenace.${event.type}`
}

const SCOPE = '@julr/tenace'

interface Instruments {
  readonly executionDuration: Histogram
  readonly attemptDuration: Histogram
  readonly attemptCount: Histogram
  readonly eventCount: Counter
  /**
   * Last state seen for each circuit breaker name.
   */
  readonly breakers: Map<string, CircuitState>
}

const instrumentsByMeter = new WeakMap<Meter, Instruments>()

/**
 * Instruments created once per meter, so every `openTelemetry()` using the same meter
 * shares them, and a single circuit breaker gauge.
 */
function instrumentsOf(meter: Meter): Instruments {
  const existing = instrumentsByMeter.get(meter)
  if (existing) return existing

  const breakers = new Map<string, CircuitState>()
  meter
    .createObservableGauge('tenace.circuit_breaker.state', {
      description: 'Circuit breaker state: 0 closed, 1 open, 2 half-open, 3 isolated',
    })
    .addCallback(observer => {
      for (const [name, state] of breakers) {
        observer.observe(STATE_VALUE[state], { 'tenace.circuit_breaker.name': name })
      }
    })
  const instruments: Instruments = {
    executionDuration: meter.createHistogram('tenace.execution.duration', {
      unit: 's',
      description: 'Duration of a Tenace execution, including every attempt and delay',
    }),
    attemptDuration: meter.createHistogram('tenace.attempt.duration', {
      unit: 's',
      description: 'Duration of one attempt of a Tenace execution',
    }),
    attemptCount: meter.createHistogram('tenace.execution.attempts', {
      unit: '{attempt}',
      description: 'Attempts (calls of the function) per Tenace execution',
      advice: { explicitBucketBoundaries: [1, 2, 3, 4, 5, 10] },
    }),
    eventCount: meter.createCounter('tenace.events', {
      unit: '{event}',
      description: 'Tenace events (retries, timeouts, rejections...)',
    }),
    breakers,
  }
  instrumentsByMeter.set(meter, instruments)
  return instruments
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
      const base: Attributes = { 'tenace.operation.name': info.name }
      const spanOptions = {
        kind: SpanKind.INTERNAL,
        attributes: { ...info.attributes, ...base, 'tenace.strategies': info.strategies.join(',') },
      }

      return tracer.startActiveSpan(info.name, spanOptions, async root => {
        const started = performance.now()
        const rootContext = trace.setSpan(context.active(), root)
        const running = new Set<Span>()
        let attempts = 0
        let ended = false
        let failure: { error: unknown } | undefined

        try {
          const result = await run({
            attempt: (attemptInfo, fn) => {
              if (ended) return fn()
              attempts++
              return tracer.startActiveSpan(
                `${info.name} attempt`,
                {
                  kind: SpanKind.INTERNAL,
                  attributes: { ...base, 'tenace.attempt.number': attemptInfo.attempt },
                },
                rootContext,
                async span => {
                  running.add(span)
                  const attemptStarted = performance.now()
                  let result: AnyResult | undefined
                  try {
                    result = await fn()
                    return result
                  } finally {
                    // otherwise abandoned: ended with the execution
                    if (running.delete(span)) {
                      const failed = result && !result.ok ? result : undefined
                      const duration = (performance.now() - attemptStarted) / 1000
                      runAll(
                        () => failed && recordError(span, failed.error),
                        () => span.end(),
                        () =>
                          instruments.attemptDuration.record(duration, {
                            ...base,
                            ...(failed && { 'error.type': errorType(failed.error) }),
                          }),
                      )
                    }
                  }
                },
              )
            },
            event: event => {
              if (ended) return
              if (event.type === 'circuit.state_changed') {
                instruments.breakers.set(event.breaker, event.to)
              }
              instruments.eventCount.add(1, { ...base, 'tenace.event.name': event.type })
              if (spanEvents) root.addEvent(eventName(event), eventAttributes(event))
            },
          })
          if (!result.ok) failure = { error: result.error }
          return result
        } catch (error) {
          failure = { error }
          throw error
        } finally {
          ended = true
          const duration = (performance.now() - started) / 1000
          const abandoned = [...running]
          running.clear()
          const attributes = {
            ...base,
            ...(failure && { 'error.type': errorType(failure.error) }),
          }
          runAll(
            ...abandoned.map(
              span => () =>
                runAll(
                  () => span.setAttribute('tenace.attempt.abandoned', true),
                  () =>
                    span.setStatus({
                      code: SpanStatusCode.ERROR,
                      message: 'The execution ended before the attempt settled',
                    }),
                  () => span.end(),
                ),
            ),
            () => failure && recordError(root, failure.error),
            () => root.setAttribute('tenace.attempts', attempts),
            () => root.end(),
            () => instruments.executionDuration.record(duration, attributes),
            () => instruments.attemptCount.record(attempts, attributes),
          )
        }
      })
    },
  }
}
