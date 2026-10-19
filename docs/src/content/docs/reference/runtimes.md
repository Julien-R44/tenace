---
title: Runtimes
description: Where Tenace runs, and what depends on the runtime.
---

Tenace is ESM only and has no runtime dependencies. It runs on:

| Runtime            | Version                                  |
| ------------------ | ---------------------------------------- |
| Node.js            | 22.18 or later                           |
| Bun                | latest, tested in CI                     |
| Cloudflare Workers | with or without the `nodejs_compat` flag |

The CI of the repository runs the test suite on Node.js 22, 24, and 26 and on Bun, and runs the built bundle in workerd through Miniflare, with and without `nodejs_compat`.

## TypeScript

The types need TypeScript 5.9 or later, the oldest version the CI typechecks against, along with TypeScript 7, both with `strict` enabled. The package exports ESM only: use the `module` resolution `nodenext`, `node16`, or `bundler`, not `node10`.

## Runtime-dependent features

The package has no static `node:` import. Two features depend on the runtime:

- **`diagnostics_channel`.** Tenace loads it with `process.getBuiltinModule()` the first time an execution runs. Where it is missing, such as Workers without `nodejs_compat`, nothing is published and nothing fails. See [diagnostics_channel](/observability/diagnostics-channel/).
- **Timers.** The system clock uses the global `setTimeout` and `clearTimeout`, which every supported runtime provides. It chains them for delays beyond their limit of 2^31 - 1 ms.

The `@julr/tenace-otel` package depends only on `@opentelemetry/api`, and runs wherever an OpenTelemetry SDK does.
