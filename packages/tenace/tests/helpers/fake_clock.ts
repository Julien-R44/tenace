import { Clock } from '../../src/clock/clock.ts'
import type { FakeClock } from '../../src/clock/fake_clock.ts'

/**
 * A clock of its own, faked at `at` milliseconds since the epoch, so a test does not fake
 * the shared one.
 */
export function fakeClock(at = 0): { clock: Clock; time: FakeClock } {
  const clock = new Clock()
  const time = clock.fake(new Date(at))
  return { clock, time }
}
