# Changelog

## 2.0.0

First release. `openTelemetry()` returns a Tenace instrumentation that records traces and metrics through `@opentelemetry/api`. Pass it to `Tenace.instrument()` for every policy, or to the `instrumentation` option of one policy.

- **Traces**: one span per execution, one child span per attempt, and the Tenace events as span events. A retried attempt does not mark the execution span as failed.
- **Metrics**: `tenace.execution.duration`, `tenace.attempt.duration`, `tenace.execution.attempts`, `tenace.events`, and the `tenace.circuit_breaker.state` gauge.
- **Errors**: `error.type` is the `_tag` of a typed error, else the `name` of an `Error` (its class name when `name` is the default `'Error'`), else `_OTHER`.
- **Lazy setup**: the default tracer and meter are looked up on each execution, so `openTelemetry()` can be called before the SDK starts.
