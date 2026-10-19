import { test } from '@japa/runner'
import { context, metrics, type Meter, SpanStatusCode } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { CircuitBreaker, err, Tenace, TenaceError } from '@julr/tenace'

import { errorType, openTelemetry } from '../src/index.ts'

class PullReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE })
  }
  protected override async onShutdown(): Promise<void> {}
  protected override async onForceFlush(): Promise<void> {}
}

class HttpError extends TenaceError {
  readonly _tag = 'HttpError' as const
  readonly code = 'E_HTTP' as const
}

function setup(options: { meter?: Meter } = {}) {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const reader = new PullReader()
  const meterProvider = new MeterProvider({ readers: [reader] })
  const meter = options.meter ?? meterProvider.getMeter('tenace-test')
  const instrumentation = openTelemetry({ tracer: provider.getTracer('tenace-test'), meter })
  const spans = () => exporter.getFinishedSpans()
  const byName = (name: string) => spans().filter(span => span.name === name)
  const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId
  const metric = async (name: string) => {
    const { resourceMetrics } = await reader.collect()
    return resourceMetrics.scopeMetrics
      .flatMap(scope => scope.metrics)
      .find(m => m.descriptor.name === name)
  }
  return { instrumentation, provider, meterProvider, reader, spans, byName, parentOf, metric }
}

const contextManager = new AsyncLocalStorageContextManager()

test.group('openTelemetry', group => {
  group.setup(() => {
    context.setGlobalContextManager(contextManager.enable())
    return () => {
      context.disable()
    }
  })

  test('one span per execution and per attempt, user spans nest in attempts', async ({
    assert,
  }) => {
    const { instrumentation, provider, byName, parentOf } = setup()
    const userTracer = provider.getTracer('app')
    let calls = 0

    const value = await Tenace.policy({ name: 'users.get', instrumentation })
      .withRetry({ retries: 2, delay: 0 })
      .execute(() =>
        userTracer.startActiveSpan('fetch users/1', span => {
          span.end()
          if (++calls === 1) throw new TypeError('ECONNRESET')
          return 'user'
        }),
      )

    assert.equal(value, 'user')
    const [root] = byName('users.get')
    const attempts = byName('users.get attempt')
    const userSpans = byName('fetch users/1')
    assert.exists(root)
    assert.lengthOf(attempts, 2)
    assert.lengthOf(userSpans, 2)

    assert.deepEqual(
      attempts.map(span => parentOf(span)),
      [root!.spanContext().spanId, root!.spanContext().spanId],
    )
    assert.deepEqual(
      userSpans.map(span => parentOf(span)),
      attempts.map(span => span.spanContext().spanId),
    )

    // the retried error marks the attempt only
    assert.equal(attempts[0]!.status.code, SpanStatusCode.ERROR)
    assert.equal(attempts[0]!.attributes['error.type'], 'TypeError')
    assert.equal(attempts[1]!.status.code, SpanStatusCode.UNSET)
    assert.equal(root!.status.code, SpanStatusCode.UNSET)
    assert.equal(root!.attributes['tenace.attempts'], 2)
    assert.equal(root!.attributes['tenace.strategies'], 'retry')
    assert.deepEqual(
      root!.events.map(event => event.name),
      ['tenace.retry.scheduled'],
    )
  })

  test('a retry caused by a value has no error.type', async ({ assert }) => {
    const { instrumentation, byName } = setup()
    let calls = 0
    await Tenace.call(() => ({ status: ++calls === 1 ? 503 : 200 }), {
      name: 'poll',
      instrumentation,
    })
      .withRetry({ retries: 1, delay: 0, retryIfValue: res => res.status === 503 })
      .execute()
    const [root] = byName('poll')
    const [scheduled] = root!.events
    assert.equal(scheduled!.name, 'tenace.retry.scheduled')
    assert.equal(scheduled!.attributes?.['tenace.retry.cause'], 'value')
    assert.notProperty(scheduled!.attributes ?? {}, 'error.type')
    assert.equal(root!.status.code, SpanStatusCode.UNSET)
  })

  test('the execution span records the final failure', async ({ assert }) => {
    const { instrumentation, byName } = setup()
    await Tenace.policy({ name: 'charge', instrumentation }).settle(() => err(new HttpError('402')))
    const [root] = byName('charge')
    assert.equal(root!.status.code, SpanStatusCode.ERROR)
    assert.equal(root!.attributes['error.type'], 'HttpError')
  })

  test('a fallback keeps the execution span unset and adds an event', async ({ assert }) => {
    const { instrumentation, byName } = setup()
    await Tenace.policy({ name: 'profile', instrumentation })
      .withFallback(() => null)
      .execute(() => {
        throw new Error('down')
      })
    const [root] = byName('profile')
    assert.equal(root!.status.code, SpanStatusCode.UNSET)
    assert.deepEqual(
      root!.events.map(event => event.name),
      ['tenace.fallback.used'],
    )
  })

  test('the execution span is a child of the active span', async ({ assert }) => {
    const { instrumentation, provider, byName, parentOf } = setup()
    await provider.getTracer('app').startActiveSpan('GET /profile', async request => {
      await Tenace.policy({ name: 'nested', instrumentation }).execute(() => 1)
      request.end()
    })
    const [request] = byName('GET /profile')
    assert.equal(parentOf(byName('nested')[0]!), request!.spanContext().spanId)
  })

  test('records metrics', async ({ assert }) => {
    const { instrumentation, metric } = setup()
    const breaker = new CircuitBreaker({ name: 'users-api', trip: { consecutive: 1 } })
    const policy = Tenace.policy({ name: 'metrics', instrumentation })
      .with(breaker)
      .withRetry({ retries: 1, delay: 0, retryOn: ['UnexpectedError', 'CircuitOpenError'] })
    await policy.settle(() => {
      throw new Error('down')
    })

    const executions = await metric('tenace.execution.duration')
    assert.equal(executions?.dataPoints.length, 1)
    assert.deepEqual(executions?.dataPoints[0]?.attributes, {
      'tenace.operation.name': 'metrics',
      'error.type': 'CircuitOpenError',
    })

    const attempts = await metric('tenace.execution.attempts')
    assert.equal((attempts!.dataPoints[0]!.value as { sum: number }).sum, 1)

    // bounded cardinality: no attempt number
    const attemptDurations = await metric('tenace.attempt.duration')
    assert.deepEqual(attemptDurations?.dataPoints[0]?.attributes, {
      'tenace.operation.name': 'metrics',
      'error.type': 'Error',
    })

    const events = await metric('tenace.events')
    const names = events?.dataPoints.map(point => point.attributes['tenace.event.name']).sort()
    assert.deepEqual(names, [
      'circuit.rejected',
      'circuit.state_changed',
      'retry.exhausted',
      'retry.scheduled',
    ])

    const state = await metric('tenace.circuit_breaker.state')
    assert.equal(state?.dataPoints[0]?.value, 1)
  })

  test('an error that cannot be stringified still ends every span', async ({ assert }) => {
    const { instrumentation, spans, byName, metric } = setup()
    const result = await Tenace.policy({ name: 'opaque', instrumentation })
      .withRetry({ retries: 1, delay: 0 })
      .settle(async () => err(Object.create(null)))
    assert.isFalse(result.ok)

    assert.sameMembers(
      spans().map(span => span.name),
      ['opaque attempt', 'opaque attempt', 'opaque'],
    )
    const [root] = byName('opaque')
    assert.equal(root!.attributes['error.type'], '_OTHER')
    assert.equal(root!.status.message, '[object Object]')
    const attemptDurations = await metric('tenace.attempt.duration')
    assert.equal((attemptDurations!.dataPoints[0]!.value as { count: number }).count, 2)
  })

  test('nested retries count every call of the function', async ({ assert }) => {
    const { instrumentation, byName, metric } = setup()
    await Tenace.policy({ name: 'nested-retries', instrumentation })
      .withRetry({ retries: 1, delay: 0 })
      .withRetry({ retries: 1, delay: 0 })
      .settle(() => err('down'))

    const attempts = byName('nested-retries attempt')
    assert.deepEqual(
      attempts.map(span => span.attributes['tenace.attempt.number']),
      [1, 2, 1, 2],
    )
    assert.equal(byName('nested-retries')[0]!.attributes['tenace.attempts'], 4)
    const counts = await metric('tenace.execution.attempts')
    assert.equal((counts!.dataPoints[0]!.value as { sum: number }).sum, 4)
  })

  test('attempts still running are ended with the execution', async ({ assert }) => {
    const { instrumentation, byName } = setup()
    let finish!: () => void
    const late = new Promise<void>(resolve => (finish = resolve))
    const result = await Tenace.policy({ name: 'slow', instrumentation })
      .withTimeout(5)
      .settle(async () => {
        await late
        throw new Error('too late')
      })
    assert.isFalse(result.ok)

    const [root] = byName('slow')
    const [attempt] = byName('slow attempt')
    assert.exists(root)
    assert.equal(attempt?.attributes['tenace.attempt.abandoned'], true)
    assert.equal(attempt!.status.code, SpanStatusCode.ERROR)

    // settling later changes nothing
    finish()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.lengthOf(byName('slow attempt'), 1)
    assert.isUndefined(attempt!.attributes['error.type'])
  })

  test('the global meter provider may be registered after openTelemetry()', async ({ assert }) => {
    const instrumentation = openTelemetry({ meter: undefined, spanEvents: undefined })
    const reader = new PullReader()
    metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }))
    try {
      await Tenace.policy({ name: 'late-sdk', instrumentation }).execute(() => 1)
      const { resourceMetrics } = await reader.collect()
      const names = resourceMetrics.scopeMetrics.flatMap(scope =>
        scope.metrics.map(m => m.descriptor.name),
      )
      assert.include(names, 'tenace.execution.duration')
    } finally {
      metrics.disable()
    }
  })

  test('instrumentations sharing a meter register one circuit breaker gauge', async ({
    assert,
  }) => {
    const meter = new MeterProvider().getMeter('shared')
    let gauges = 0
    const createGauge = meter.createObservableGauge.bind(meter)
    meter.createObservableGauge = (...args) => (gauges++, createGauge(...args))

    for (const name of ['first', 'second']) {
      const { instrumentation } = setup({ meter })
      await Tenace.policy({ name, instrumentation }).execute(() => 1)
    }
    assert.equal(gauges, 1)
  })

  test('errorType', ({ assert }) => {
    assert.equal(errorType(new HttpError('x')), 'HttpError')
    assert.equal(errorType(new RangeError('x')), 'RangeError')
    assert.equal(errorType({ _tag: 'Custom' }), 'Custom')
    assert.equal(errorType('string'), '_OTHER')
  })

  test('errorType of an Error subclass that keeps the default name is its class name', async ({
    assert,
  }) => {
    class PaymentDeclined extends Error {}
    class Named extends Error {
      override name = 'CustomName'
    }
    assert.equal(errorType(new PaymentDeclined('x')), 'PaymentDeclined')
    assert.equal(errorType(new Named('x')), 'CustomName')
    assert.equal(errorType(new Error('x')), 'Error')

    const { instrumentation, byName } = setup()
    await Tenace.policy({ name: 'pay', instrumentation }).settle(() => {
      throw new PaymentDeclined('declined')
    })
    assert.equal(byName('pay')[0]!.attributes['error.type'], 'PaymentDeclined')
  })
})
