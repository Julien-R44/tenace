import type { Counter, Histogram, Meter } from '@opentelemetry/api'
import type { CircuitState } from '@julr/tenace'

const STATE_VALUE: Record<CircuitState, number> = {
  'closed': 0,
  'open': 1,
  'half-open': 2,
  'isolated': 3,
}

export interface Instruments {
  readonly executionDuration: Histogram
  readonly attemptDuration: Histogram
  readonly attemptCount: Histogram
  readonly eventCount: Counter
  /**
   * Last state seen for each circuit breaker name, read by the state gauge.
   */
  readonly breakers: Map<string, CircuitState>
}

const instrumentsByMeter = new WeakMap<Meter, Instruments>()

/**
 * Instruments created once per meter, so every `openTelemetry()` using the same meter
 * shares them, and a single circuit breaker gauge.
 */
export function instrumentsOf(meter: Meter): Instruments {
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
