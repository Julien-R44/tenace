/**
 * Modules of the AdonisJS app that the snippets of `guides/adonisjs.md` import through `#`
 * aliases. Each one matches the snippet that defines it on that page.
 */
declare module '#errors/city_not_found' {
  import type { Exception } from '@adonisjs/core/exceptions'

  export class CityNotFound extends Exception {
    readonly _tag: 'CityNotFound'
    readonly city: string
    constructor(city: string)
  }
}

declare module '#errors/weather_api_down' {
  import type { Exception } from '@adonisjs/core/exceptions'

  export class WeatherApiDown extends Exception {
    readonly _tag: 'WeatherApiDown'
    readonly upstreamStatus: number
    constructor(upstreamStatus: number)
  }
}

declare module '#services/weather_api' {
  export interface Forecast {
    readonly city: string
    readonly temperature: number
  }

  export class WeatherApi {
    fetchForecast(city: string, signal: AbortSignal): Promise<Response>
  }
}

declare module '#services/weather_service' {
  import type {
    CircuitBreaker,
    CircuitOpenError,
    Result,
    TimeoutError,
    UnexpectedError,
  } from '@julr/tenace'
  import type { CityNotFound } from '#errors/city_not_found'
  import type { WeatherApiDown } from '#errors/weather_api_down'
  import type { Forecast } from '#services/weather_api'

  export class WeatherService {
    static readonly breaker: CircuitBreaker
    forecast(
      city: string,
    ): Promise<
      Result<
        Forecast,
        CityNotFound | WeatherApiDown | UnexpectedError | TimeoutError | CircuitOpenError
      >
    >
  }
}
