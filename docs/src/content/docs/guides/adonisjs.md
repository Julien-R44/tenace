---
title: Use with AdonisJS
description: Call an external API through a policy in an AdonisJS app, match each error in the controller, log the events, and test.
---

This guide puts a policy around a weather API in an AdonisJS app. Tenace needs no adapter: your exceptions, the exception handler, and the container work as usual.

## Add a `_tag` to your exceptions

Tenace types an error by its literal `_tag`, so an Adonis `Exception` with a `_tag` is a typed error:

```ts
// app/errors/city_not_found.ts
import { Exception } from '@adonisjs/core/exceptions'

export class CityNotFound extends Exception {
  static status = 404
  static code = 'E_CITY_NOT_FOUND'
  readonly _tag = 'CityNotFound' as const

  constructor(readonly city: string) {
    super(`No forecast for "${city}"`)
  }
}
```

The API can also be down. That failure is expected too, so give it its own exception:

```ts
// app/errors/weather_api_down.ts
import { Exception } from '@adonisjs/core/exceptions'

export class WeatherApiDown extends Exception {
  static status = 503
  static code = 'E_WEATHER_API_DOWN'
  readonly _tag = 'WeatherApiDown' as const

  constructor(readonly upstreamStatus: number) {
    super(`Weather API answered ${upstreamStatus}`)
  }
}
```

These exceptions keep `status`, `code`, `handle()`, and `report()`. It does not need to extend [`TenaceError`](/reference/errors/#tenaceerror), which adds `toJSON()` and an `instanceof` that works across copies of a package. An app rarely needs either.

## Call the API through a policy

```ts
// app/services/weather_service.ts
import { inject } from '@adonisjs/core'
import { CircuitBreaker, Result, Tenace } from '@julr/tenace'

import { CityNotFound } from '#errors/city_not_found'
import { WeatherApiDown } from '#errors/weather_api_down'
import { type Forecast, WeatherApi } from '#services/weather_api'

@inject()
export class WeatherService {
  static readonly breaker = new CircuitBreaker({
    trip: { consecutive: 5 },
    openFor: '30s',
  })

  constructor(private api: WeatherApi) {}

  forecast(city: string) {
    return Tenace.call(({ signal }) => this.#fetch(city, signal), {
      name: 'weather.forecast',
    })
      .withTimeout('2s')
      .withRetry({
        retries: 2,
        retryOn: ['TimeoutError', 'WeatherApiDown', 'UnexpectedError'],
      })
      .with(WeatherService.breaker)
      .settle()
  }

  async #fetch(city: string, signal: AbortSignal) {
    const response = await this.api.fetchForecast(city, signal)

    if (response.status === 404) return Result.err(new CityNotFound(city))
    if (!response.ok) return Result.err(new WeatherApiDown(response.status))

    return Result.ok((await response.json()) as Forecast)
  }
}
```

TypeScript infers the return type of `forecast()`: a promise of `Result<Forecast, CityNotFound | WeatherApiDown | TimeoutError | CircuitOpenError | UnexpectedError>`.

- `Tenace.call()` builds the policy on each call. Timeout and retry keep no state, so that is correct. The breaker counts failures across calls, so every call must share one instance: it is `static`. A breaker created inside `forecast()` would start closed on every call and never open.
- `fetch` does not reject on a 5xx response. `#fetch()` returns a `WeatherApiDown` for it, so the retry and the breaker count it as a failure.
- `retryOn` retries timeouts, `WeatherApiDown`, and what `#fetch()` throws, such as a network error. It does not retry `CityNotFound`: the city will still be unknown on the next attempt.
- `#fetch()` passes `signal` to the API client. When the timeout fires, `fetch` stops the request.

## Match each error in the controller

`Result.match()` needs one handler per error. If you add a strategy to the policy later, the controller fails to compile until it handles the new error.

```ts
// app/controllers/forecasts_controller.ts
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { Result } from '@julr/tenace'

import { WeatherService } from '#services/weather_service'

@inject()
export default class ForecastsController {
  constructor(private weather: WeatherService) {}

  async show({ params, response }: HttpContext) {
    const result = await this.weather.forecast(params.city)

    return Result.match(result, {
      ok: forecast => forecast,
      CityNotFound: error => response.notFound({ message: error.message }),
      WeatherApiDown: () => response.serviceUnavailable('Try again later'),
      TimeoutError: () => response.serviceUnavailable('Try again later'),
      CircuitOpenError: () => response.serviceUnavailable('Try again later'),
      UnexpectedError: error => {
        throw error.cause
      },
    })
  }
}
```

An `UnexpectedError` holds what `#fetch()` threw, such as a network error. Rethrow `error.cause`, and the exception handler renders it as usual: a 500 for a bug, or the status of an Adonis exception.

The 503 responses do not say whether a timeout or an open circuit caused them. The client can do nothing different in either case, and the logs keep the detail.

## Map the errors of the strategies with `execute()`

`execute()` rejects with the errors of the strategies. They have no `status`, so Adonis answers 500. To answer 503, check them in the exception handler:

```ts
// app/exceptions/handler.ts
import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { CircuitOpenError, TimeoutError } from '@julr/tenace'

export default class HttpExceptionHandler extends ExceptionHandler {
  protected debug = !app.inProduction

  async handle(error: unknown, ctx: HttpContext) {
    if (error instanceof TimeoutError || error instanceof CircuitOpenError) {
      return ctx.response.serviceUnavailable('Try again later')
    }
    return super.handle(error, ctx)
  }
}
```

## Log the events with the request ID

Register a [listener](/observability/instrumentation/) in a preload file. `HttpContext.get()` returns the context of the current request, so each event goes to the request logger, with its `request_id`:

```ts
// start/tenace.ts
import { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import { listener, Tenace } from '@julr/tenace'

const QUIET = new Set(['cache.hit', 'cache.miss', 'dedupe.joined'])

Tenace.instrument(
  listener((event, { name }) => {
    if (QUIET.has(event.type)) return
    const log = HttpContext.get()?.logger ?? logger
    log.warn({ policy: name, ...event }, `tenace: ${event.type}`)
  }),
)
```

`HttpContext.get()` needs `useAsyncLocalStorage: true` in `config/app.ts`. Add the file to the `preloads` of `adonisrc.ts`:

```ts nocheck
preloads: [
  () => import('#start/routes'),
  () => import('#start/kernel'),
  () => import('#start/tenace'),
],
```

For traces and metrics, use [`@julr/tenace-otel`](/observability/opentelemetry/).

## Reset the breaker between tests

Every test shares `WeatherService.breaker`, so a circuit opened by one test rejects the calls of the next. Close it after each test: `isolate()` then `release()` closes the circuit from any state.

```ts nocheck
// tests/functional/forecasts.spec.ts
import app from '@adonisjs/core/services/app'
import { test } from '@japa/runner'

import { WeatherApi } from '#services/weather_api'
import { WeatherService } from '#services/weather_service'

test.group('Forecasts', group => {
  group.each.teardown(async () => {
    app.container.restore(WeatherApi)
    const release = await WeatherService.breaker.isolate()
    await release()
  })

  test('an open circuit answers 503', async ({ client }) => {
    class DownWeatherApi extends WeatherApi {
      async fetchForecast() {
        return Response.json({}, { status: 500 })
      }
    }
    app.container.swap(WeatherApi, () => new DownWeatherApi())

    for (let i = 0; i < 5; i++) await client.get('/forecasts/Paris')

    const response = await client.get('/forecasts/Paris').accept('json')
    response.assertStatus(503)
  })
})
```

The policy uses the system clock, so a timeout test waits for the real timeout. To keep such tests short, read the durations from your config.
