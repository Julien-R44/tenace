export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd'

/**
 * A duration in milliseconds, or a string with a single unit: `'250ms'`, `'1.5s'`, `'2m'`, `'1h'`, `'1d'`.
 *
 * The number of a string is a non-negative decimal (`'+1s'`, `'5.s'` and `'1e3ms'` work too).
 * The type also accepts whatever TypeScript reads as a number, like `'-1s'`, `' 1s'` or
 * `'0x10ms'`: those throw a `RangeError`.
 */
export type Duration = number | `${number}${DurationUnit}`

const UNIT_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}
const DURATION_PATTERN = /^(\+?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(ms|s|m|h|d)$/

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
  const ms = match ? Number(match[1]) * UNIT_MS[match[2] as DurationUnit] : Number.NaN
  if (!Number.isFinite(ms)) {
    throw new RangeError(
      `Invalid duration: "${duration}". Expected a number of ms or a string like "250ms", "1.5s", "2m", "1h", "1d"`,
    )
  }
  return ms
}
