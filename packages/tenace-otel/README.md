# @julr/tenace-otel

OpenTelemetry instrumentation for [`@julr/tenace`](../tenace): traces and metrics for every execution.

> [!WARNING]
> Tenace is still in development and is not published yet.

## Install

```sh
pnpm add @julr/tenace-otel @opentelemetry/api
```

## Usage

```ts
import { Tenace } from '@julr/tenace'
import { openTelemetry } from '@julr/tenace-otel'

// every policy
Tenace.instrument(openTelemetry())

// or one policy
Tenace.policy({ name: 'users.get', instrumentation: openTelemetry({ tracer, meter }) })
```

| Option       | Default                                 |
| ------------ | --------------------------------------- |
| `tracer`     | `trace.getTracer('@julr/tenace')`       |
| `meter`      | `metrics.getMeter('@julr/tenace')`      |
| `spanEvents` | `true`: one span event per Tenace event |

The default tracer and meter are looked up on each execution, so `openTelemetry()` can be called before the OpenTelemetry SDK is started.

## Traces

- One `INTERNAL` span per execution, named after the policy (`name` option of the policy or of `execute()`). Its attributes:
  - `tenace.operation.name`;
  - `tenace.strategies`;
  - `tenace.attempts`: how many times the function was called, nested retries included;
  - the `attributes` passed to `execute()`.
- One child span per attempt (`<name> attempt`) with `tenace.attempt.number`, the attempt number of the innermost retry (with nested retries it starts again at 1 for each outer attempt). Spans created by your function nest under it.
- An attempt still running when the execution ends (a timeout returned without waiting for the function) is ended with the execution span, with the `ERROR` status and `tenace.attempt.abandoned: true`. It is not recorded in `tenace.attempt.duration`.
- A failed attempt gets the `ERROR` status and `error.type` (the error `_tag`, or the class name of a thrown error) on its own span. The execution span gets them only when the execution fails in the end, so a retried attempt does not mark it as failed.
- Tenace events (`retry.scheduled`, `timeout`, `circuit.state_changed`, `fallback.used`...) are recorded as span events on the execution span.

## Metrics

| Name                           | Type                                             |
| ------------------------------ | ------------------------------------------------ |
| `tenace.execution.duration`    | histogram, seconds                               |
| `tenace.attempt.duration`      | histogram, seconds                               |
| `tenace.execution.attempts`    | histogram                                        |
| `tenace.events`                | counter, by `tenace.event.name`                  |
| `tenace.circuit_breaker.state` | gauge: 0 closed, 1 open, 2 half-open, 3 isolated |

Durations, attempts and events have `tenace.operation.name` (and `error.type` on failures, except events). `tenace.circuit_breaker.state` is keyed by `tenace.circuit_breaker.name`: give each breaker a unique `name` (unnamed breakers all share `circuitBreaker`). A breaker is reported once an execution saw it change state.

## License

MIT
