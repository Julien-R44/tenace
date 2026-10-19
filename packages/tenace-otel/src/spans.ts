import { type Span, SpanStatusCode } from '@opentelemetry/api'
import { UnexpectedError } from '@julr/tenace'

import { describe, errorType } from './error_type.ts'
import { runAll } from './run_all.ts'

/**
 * Marks a span as failed: `error.type`, the exception, and an ERROR status.
 */
export function recordError(span: Span, error: unknown): void {
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
 * Ends an attempt still running when its execution ends (a timeout returned without
 * waiting for the function).
 */
export function endAbandoned(span: Span): void {
  runAll(
    () => span.setAttribute('tenace.attempt.abandoned', true),
    () =>
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'The execution ended before the attempt settled',
      }),
    () => span.end(),
  )
}
