import type { Instrumentation } from '../instrumentation.ts'
import type { AnyStrategy } from '../strategy.ts'

const KEY: unique symbol = Symbol.for('@julr/tenace/instrumentation') as never
const CHAOS_KEY: unique symbol = Symbol.for('@julr/tenace/chaos') as never
const SETTINGS_KEY: unique symbol = Symbol.for('@julr/tenace/settings') as never

interface Setting {
  previous: unknown
}

const holder = globalThis as {
  [KEY]?: Instrumentation | undefined
  [CHAOS_KEY]?: AnyStrategy | undefined
  [SETTINGS_KEY]?: Record<typeof KEY | typeof CHAOS_KEY, Setting[]>
}

// on globalThis like the values, so duplicated package copies share one stack
const settings = (holder[SETTINGS_KEY] ??= { [KEY]: [], [CHAOS_KEY]: [] })

/**
 * Sets a global until the returned function is called. The global stays the latest setting
 * not restored yet, so restoring out of order does not clobber a newer one.
 */
function override(key: typeof KEY | typeof CHAOS_KEY, value: unknown): () => void {
  const stack = settings[key]
  const setting: Setting = { previous: holder[key] }
  stack.push(setting)
  holder[key] = value as never
  return () => {
    const index = stack.indexOf(setting)
    if (index === -1) return
    stack.splice(index, 1)
    const newer = stack[index]
    if (newer) newer.previous = setting.previous
    else holder[key] = setting.previous as never
  }
}

export function getGlobalInstrumentation(): Instrumentation | undefined {
  return holder[KEY]
}

export function overrideGlobalInstrumentation(
  instrumentation: Instrumentation | undefined,
): () => void {
  return override(KEY, instrumentation)
}

/**
 * Chaos strategy injected around every function call (testing).
 */
export function getGlobalChaos(): AnyStrategy | undefined {
  return holder[CHAOS_KEY]
}

export function overrideGlobalChaos(chaos: AnyStrategy | undefined): () => void {
  return override(CHAOS_KEY, chaos)
}
