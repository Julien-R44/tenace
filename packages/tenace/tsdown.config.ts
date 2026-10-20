import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    './src/index.ts',
    './src/result/index.ts',
    './src/testing/index.ts',
    './src/adapters/rate_limiter_flexible.ts',
    './src/adapters/verrou.ts',
    './src/adapters/bentocache.ts',
  ],
  outDir: './build',
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  fixedExtension: false,
  dts: true,
  unbundle: true,
  clean: true,
  treeshake: false,
  sourcemap: false,
})
