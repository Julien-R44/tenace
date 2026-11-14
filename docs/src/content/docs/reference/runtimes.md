---
title: Runtimes
description: Where Tenace runs, and what depends on the runtime.
---

Tenace is ESM only. Its one runtime dependency is [`temporal-polyfill`](https://github.com/fullcalendar/temporal-polyfill), for runtimes without a native `Temporal`. It runs on:

| Runtime            | Version                                  |
| ------------------ | ---------------------------------------- |
| Node.js            | 22.18 or later                           |
| Bun                | latest, tested in CI                     |
| Cloudflare Workers | with or without the `nodejs_compat` flag |

The CI of the repository runs the test suite on Node.js 22, 24, and 26 and on Bun. It runs the built bundle in workerd through Miniflare, with and without `nodejs_compat`, on both the fallback and native Temporal paths.

## TypeScript

The types need TypeScript 5.9 or later, the oldest version the CI typechecks against, along with TypeScript 7, both with `strict` enabled. The package exports ESM only: use the `module` resolution `nodenext`, `node16`, or `bundler`, not `node10`.

## Runtime-dependent features

The package has no static `node:` import. These features depend on the runtime:

- **`diagnostics_channel`.** Tenace loads it with `process.getBuiltinModule()` the first time an execution runs. Where it is missing, such as Workers without `nodejs_compat`, nothing is published and nothing fails. See [diagnostics_channel](/observability/diagnostics-channel/).
- **Timers.** The system clock uses the global `setTimeout` and `clearTimeout`, which every supported runtime provides. It chains them for delays beyond their limit of 2^31 - 1 ms.
- **Temporal.** `clock.now()` returns a `Temporal.Instant`. Tenace uses the native API whenever available, including Node.js 26, Bun, and recent Workers with the `temporal` compatibility flag. Node.js 24, Node.js 22, and Workers without Temporal use a dynamic import of `temporal-polyfill`. The fallback does not modify `globalThis`. Node.js 24 applications, including AdonisJS, need no runtime flag or application-level polyfill setup.

`pnpm test:workerd` checks the fallback with the repository's workerd version. `pnpm test:workerd:native` checks native Temporal on workerd 2026-11-04 with the `temporal` flag. The native smoke test also rejects any bundle that invokes the fallback loader.

The `@julr/tenace-otel` package depends only on `@opentelemetry/api`, and runs wherever an OpenTelemetry SDK does.
