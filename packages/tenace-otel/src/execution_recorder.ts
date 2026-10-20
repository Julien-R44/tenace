import {
  type Attributes,
  type Context,
  context,
  type Span,
  SpanKind,
  trace,
  type Tracer,
} from '@opentelemetry/api'
import type { AttemptInfo, ExecutionScope, Result, TenaceEvent } from '@julr/tenace'

import { errorType } from './error_type.ts'
import { eventAttributes, eventName } from './events.ts'
import type { Instruments } from './instruments.ts'
import { runAll } from './run_all.ts'
import { endAbandoned, recordError } from './spans.ts'

export interface ExecutionRecorderOptions {
  readonly name: string
  readonly root: Span
  readonly tracer: Tracer
  readonly instruments: Instruments
  readonly spanEvents: boolean
}

/**
 * Records one execution: a child span and a duration per attempt, the events on the root
 * span, and the execution metrics once it ends. Nothing is recorded after `end()`.
 */
export class ExecutionRecorder implements ExecutionScope {
  readonly #name: string
  readonly #root: Span
  readonly #rootContext: Context
  readonly #tracer: Tracer
  readonly #instruments: Instruments
  readonly #spanEvents: boolean
  readonly #base: Attributes
  readonly #started = performance.now()
  /**
   * Attempt spans not ended yet.
   */
  readonly #running = new Set<Span>()
  #attempts = 0
  #ended = false

  constructor(options: ExecutionRecorderOptions) {
    this.#name = options.name
    this.#root = options.root
    this.#rootContext = trace.setSpan(context.active(), options.root)
    this.#tracer = options.tracer
    this.#instruments = options.instruments
    this.#spanEvents = options.spanEvents
    this.#base = { 'tenace.operation.name': options.name }
  }

  attempt(info: AttemptInfo, run: () => Promise<Result.Any>): Promise<Result.Any> {
    if (this.#ended) return run()
    this.#attempts++
    return this.#tracer.startActiveSpan(
      `${this.#name} attempt`,
      {
        kind: SpanKind.INTERNAL,
        attributes: { ...this.#base, 'tenace.attempt.number': info.attempt },
      },
      this.#rootContext,
      span => this.#runAttempt(span, run),
    )
  }

  event(event: TenaceEvent): void {
    if (this.#ended) return
    if (event.type === 'circuit.state_changed') {
      this.#instruments.breakers.set(event.breaker, event.to)
    }
    this.#instruments.eventCount.add(1, { ...this.#base, 'tenace.event.name': event.type })
    if (this.#spanEvents) this.#root.addEvent(eventName(event), eventAttributes(event))
  }

  /**
   * Ends the attempts still running, then the root span, and records the execution metrics.
   */
  end(failure: { readonly error: unknown } | undefined): void {
    this.#ended = true
    const duration = (performance.now() - this.#started) / 1000
    const abandoned = [...this.#running]
    this.#running.clear()
    const attributes = this.#attributes(failure)

    runAll(
      ...abandoned.map(span => () => endAbandoned(span)),
      () => failure && recordError(this.#root, failure.error),
      () => this.#root.setAttribute('tenace.attempts', this.#attempts),
      () => this.#root.end(),
      () => this.#instruments.executionDuration.record(duration, attributes),
      () => this.#instruments.attemptCount.record(this.#attempts, attributes),
    )
  }

  async #runAttempt(span: Span, run: () => Promise<Result.Any>): Promise<Result.Any> {
    this.#running.add(span)
    const started = performance.now()
    let result: Result.Any | undefined
    try {
      result = await run()
      return result
    } finally {
      // otherwise the attempt was abandoned, and ended with the execution
      if (this.#running.delete(span)) this.#endAttempt(span, started, result)
    }
  }

  #endAttempt(span: Span, started: number, result: Result.Any | undefined): void {
    const failure = result && !result.ok ? { error: result.error } : undefined
    const duration = (performance.now() - started) / 1000
    runAll(
      () => failure && recordError(span, failure.error),
      () => span.end(),
      () => this.#instruments.attemptDuration.record(duration, this.#attributes(failure)),
    )
  }

  #attributes(failure: { readonly error: unknown } | undefined): Attributes {
    return failure ? { ...this.#base, 'error.type': errorType(failure.error) } : this.#base
  }
}
