# Tenace

> [!WARNING]
> Tenace is a work in progress and is not published yet.

Typed, composable resilience policies for TypeScript: retry, timeout, circuit breaker, bulkhead, fallback, rate limit, lock, dedupe, cache, batches and chaos testing. The error channel is typed, and the core has zero runtime dependencies.

See the [documentation](./docs), the [`@julr/tenace` README](./packages/tenace), and the [examples](./packages/tenace/examples).

## Packages

| Package                                       | Description                   |
| --------------------------------------------- | ----------------------------- |
| [`@julr/tenace`](./packages/tenace)           | Core library                  |
| [`@julr/tenace-otel`](./packages/tenace-otel) | OpenTelemetry instrumentation |

## Development

```sh
pnpm install
pnpm checks   # format, lint, typecheck (TS 7 + TS 5.9), tests
pnpm build
pnpm docs:dev # documentation site on http://localhost:4321
```

The documentation lives in [`docs/`](./docs), an [Astro Starlight](https://starlight.astro.build) site. `pnpm typecheck` also typechecks every TypeScript code block of the pages against the package sources (`docs/scripts/extract_snippets.ts`). Mark a block that is not valid on its own with ` ```ts nocheck `.
