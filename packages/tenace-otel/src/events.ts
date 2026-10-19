import type { Attributes } from '@opentelemetry/api'
import type { RetryEventCause, TenaceEvent } from '@julr/tenace'

import { errorType } from './error_type.ts'

/**
 * Name of the span event of a Tenace event.
 */
export function eventName(event: TenaceEvent): string {
  return event.type === 'custom' ? `tenace.custom.${event.name}` : `tenace.${event.type}`
}

/**
 * A retry caused by a value (`retryIfValue`) has no `error.type`.
 */
function retryCause(event: RetryEventCause): Attributes {
  return 'value' in event
    ? { 'tenace.retry.cause': 'value' }
    : { 'tenace.retry.cause': 'error', 'error.type': errorType(event.error) }
}

function retryAfter(retryAfterMs: number | undefined): Attributes {
  return retryAfterMs === undefined ? {} : { 'tenace.retry_after_ms': retryAfterMs }
}

/**
 * Attributes of the span event of a Tenace event.
 */
export function eventAttributes(event: TenaceEvent): Attributes {
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
        ...retryAfter(event.retryAfterMs),
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
      return { 'tenace.key': event.key, ...retryAfter(event.retryAfterMs) }
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
