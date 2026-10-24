export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd'

/**
 * Milliseconds, or a duration string such as `'250ms'`, `'10 seconds'`, `'2w'`, or `'1 year'`.
 * Strings without a unit are milliseconds. Invalid strings throw a `RangeError` at runtime.
 */
export type Duration = number | string

const UNIT_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}
const DURATION_PATTERN = /^(\+?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(ms|s|m|h|d)$/

/**
 * Adapted from @lukeed/ms by Luke Edwards, MIT licensed. See ../LICENSE.
 * https://github.com/lukeed/ms/blob/552c409e55b4789b9d9be7f0a592b80f2fc2676d/src/index.js
 */
const LEGACY_DURATION_PATTERN =
  /^(-?(?:\d+)?\.?\d+) *(m(?:illiseconds?|s(?:ecs?)?))?(s(?:ec(?:onds?|s)?)?)?(m(?:in(?:utes?|s)?)?)?(h(?:ours?|rs?)?)?(d(?:ays?)?)?(w(?:eeks?|ks?)?)?(y(?:ears?|rs?)?)?$/
const SEC = 1000
const MIN = SEC * 60
const HOUR = MIN * 60
const DAY = HOUR * 24
const YEAR = DAY * 365.25

function parseLegacyDuration(duration: string): number | undefined {
  const arr = duration.toLowerCase().match(LEGACY_DURATION_PATTERN)
  if (arr === null) return undefined
  const num = Number.parseFloat(arr[1]!)
  if (!num) return undefined
  if (arr[3] !== undefined) return num * SEC
  if (arr[4] !== undefined) return num * MIN
  if (arr[5] !== undefined) return num * HOUR
  if (arr[6] !== undefined) return num * DAY
  if (arr[7] !== undefined) return num * DAY * 7
  if (arr[8] !== undefined) return num * YEAR
  return num
}

/**
 * Converts a duration to milliseconds. Throws a `RangeError` for negative, `NaN` or
 * malformed input. `Infinity` is accepted and means "never".
 */
export function toMs(duration: Duration): number {
  if (typeof duration === 'number') {
    if (Number.isNaN(duration) || duration < 0) {
      throw new RangeError(`Invalid duration: ${duration}. Expected a non-negative number of ms`)
    }
    return duration
  }

  const match = DURATION_PATTERN.exec(duration)
  const ms = match
    ? Number(match[1]) * UNIT_MS[match[2] as DurationUnit]
    : parseLegacyDuration(duration)
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    throw new RangeError(
      `Invalid duration: "${duration}". Expected a non-negative number of ms or a string like "250ms", "10 seconds", "2w", "1 year"`,
    )
  }
  return ms
}
