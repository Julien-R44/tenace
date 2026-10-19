import { defineConfig } from 'oxlint'
import { julrPreset } from '@julr/tooling-configs/oxc/lint'

export default defineConfig({
  extends: [julrPreset()],
  plugins: ['typescript', 'node', 'eslint', 'oxc', 'unicorn', 'import', 'promise'],
  ignorePatterns: ['**/build/**', '.amp/**'],
  options: {
    typeAware: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: 'error',
  },
  rules: {
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    'no-console': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/await-thenable': 'error',
    'typescript/consistent-type-imports': 'error',
    'import/no-cycle': 'error',
  },
  overrides: [{ files: ['scripts/**', '**/examples/**'], rules: { 'no-console': 'off' } }],
})
