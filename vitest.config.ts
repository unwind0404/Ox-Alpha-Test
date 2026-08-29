import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/types.ts', 'src/adapters/**'],
    },
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@ports': resolve(__dirname, 'src/ports'),
      '@adapters': resolve(__dirname, 'src/adapters'),
      '@coordinator': resolve(__dirname, 'src/coordinator'),
    },
  },
})
