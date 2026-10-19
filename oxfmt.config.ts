import { julrPreset } from '@julr/tooling-configs/oxc/fmt'

const defaults = julrPreset()

export default julrPreset({
  ignorePatterns: [...(defaults.ignorePatterns ?? []), '**/build/**', '.amp/**', 'pnpm-lock.yaml'],
})
