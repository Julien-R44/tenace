import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  outDir: './build',
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  fixedExtension: false,
  dts: true,
  clean: true,
  treeshake: false,
  sourcemap: false,
})
