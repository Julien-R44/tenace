---
title: diagnostics_channel
description: Subscribe to Tenace executions, attempts, and events through node:diagnostics_channel.
---

Tenace publishes its executions on [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html). APM agents and your own tooling can subscribe without any change to the code that builds policies.

Tenace publishes only while something subscribes. It loads the module lazily with `process.getBuiltinModule()`, with no static `node:` import. On a runtime without `diagnostics_channel`, such as Cloudflare Workers without `nodejs_compat`, nothing is published.

## Channels

| Channel                      | Kind                                                        | Message            |
| ---------------------------- | ----------------------------------------------------------- | ------------------ |
| `tracing:tenace:execution:*` | tracing channel `tenace:execution`, one trace per execution | `ExecutionMessage` |
| `tracing:tenace:attempt:*`   | tracing channel `tenace:attempt`, one trace per attempt     | `AttemptMessage`   |
| `tenace:event`               | channel                                                     | `EventMessage`     |

The tracing channels publish on `start`, `end`, `asyncStart`, `asyncEnd`, and `error`, like any `tracePromise()` call.

## Messages

```ts nocheck
interface ExecutionMessage {
  readonly name: string
  readonly strategies: readonly string[]
  readonly attributes: Attributes
  result?: AnyResult // the final Result, set on asyncEnd
  error?: unknown // set on error
}

interface AttemptMessage {
  readonly execution: ExecutionMessage
  readonly attempt: number
  result?: AnyResult // the Result of the attempt
  error?: unknown
}

interface EventMessage {
  readonly execution: ExecutionMessage
  readonly event: TenaceEvent
}
```

The `start` and `asyncEnd` messages of a trace are the same object, and so is the `execution` object referenced by the attempts and events of that execution. A subscriber can store its own data on it under a symbol key.

The `ExecutionMessage`, `AttemptMessage`, and `EventMessage` types are exported by `@julr/tenace`.

## Subscribe

```ts
import diagnosticsChannel from 'node:diagnostics_channel'
import type { EventMessage, ExecutionMessage } from '@julr/tenace'

diagnosticsChannel.tracingChannel<ExecutionMessage>('tenace:execution').subscribe({
  start: message => console.log('start', message.name),
  asyncEnd: message => console.log('end', message.name, message.result?.ok),
  error: message => console.log('error', message.name, message.error),
})

diagnosticsChannel.subscribe('tenace:event', message => {
  const { execution, event } = message as EventMessage
  console.log(execution.name, event.type)
})
```

When a policy also has an instrumentation, both run. The instrumentation wraps the channel publisher.
