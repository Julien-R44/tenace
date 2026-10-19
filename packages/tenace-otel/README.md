# @julr/tenace-otel

OpenTelemetry traces and metrics for [Tenace](https://tenace.julr.dev) policies: one span per execution, one per attempt, and metrics for durations, attempts, events and circuit states.

## Install

```sh
npm install @julr/tenace @julr/tenace-otel @opentelemetry/api
```

`@julr/tenace` and `@opentelemetry/api` are peer dependencies. Set up the OpenTelemetry SDK as usual: this package only records through the API.

## Usage

```ts
import { Tenace } from '@julr/tenace'
import { openTelemetry } from '@julr/tenace-otel'

// every policy
Tenace.instrument(openTelemetry())

// or one policy
const policy = Tenace.policy({ name: 'users.get', instrumentation: openTelemetry() })
```

| Option       | Default                                 |
| ------------ | --------------------------------------- |
| `tracer`     | `trace.getTracer('@julr/tenace')`       |
| `meter`      | `metrics.getMeter('@julr/tenace')`      |
| `spanEvents` | `true`: one span event per Tenace event |

The default tracer and meter are looked up on each execution, so you can call `openTelemetry()` before the SDK starts.

## Traces

- **One `INTERNAL` span per execution**, named after the policy (the `name` option of the policy or of `execute()`). Its attributes:
  - `tenace.operation.name`;
  - `tenace.strategies`;
  - `tenace.attempts`: how many times the function was called, nested retries included;
  - the `attributes` passed to `execute()`.
- **One child span per attempt** (`<name> attempt`) with `tenace.attempt.number`, the attempt number of the innermost retry. With nested retries, it starts again at 1 for each outer attempt. Spans created by your function nest under it.
- **Abandoned attempts.** An attempt still running when the execution ends, such as a function that ignored a timeout, ends with the execution span, with the `ERROR` status and `tenace.attempt.abandoned: true`. It is not recorded in `tenace.attempt.duration`.
- **Errors.** A failed attempt gets the `ERROR` status and `error.type` (the `_tag` of the error, or the class name of a thrown one) on its own span. The execution span gets them only when the execution fails in the end, so a retried attempt does not mark it as failed.
- **Events.** Tenace events (`retry.scheduled`, `timeout`, `circuit.state_changed`, `fallback.used`...) are recorded as span events on the execution span. A retry caused by a value has `tenace.retry.cause: 'value'` and no `error.type`.

## Metrics

| Name                           | Type                                             |
| ------------------------------ | ------------------------------------------------ |
| `tenace.execution.duration`    | histogram, seconds                               |
| `tenace.attempt.duration`      | histogram, seconds                               |
| `tenace.execution.attempts`    | histogram                                        |
| `tenace.events`                | counter, by `tenace.event.name`                  |
| `tenace.circuit_breaker.state` | gauge: 0 closed, 1 open, 2 half-open, 3 isolated |

Durations, attempts and events have `tenace.operation.name`, and `error.type` on failures (except events). `tenace.circuit_breaker.state` is keyed by `tenace.circuit_breaker.name`: give each breaker a unique `name`, since unnamed breakers all share `circuitBreaker`. A breaker is reported once an execution saw it change state.

See [OpenTelemetry](https://tenace.julr.dev/observability/opentelemetry/) in the documentation.

## License

MIT
