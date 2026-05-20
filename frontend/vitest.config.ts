// Vitest config. Mirrors the renderer's path aliases from
// `tsconfig.web.json` so spec files can `import from '@/...'` and
// `'@shared/...'` the same way the runtime code does.
//
// Environment is `node` because today's specs cover pure helpers and
// Pinia stores with mocked platform APIs. When DOM / Vue-component tests
// show up we'll switch the relevant files to `// @vitest-environment jsdom`
// rather than forcing the whole suite through jsdom.

import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const here = (p: string): string => resolve(__dirname, p)

export default defineConfig({
  resolve: {
    alias: {
      '@': here('src/renderer/src'),
      '@shared': here('src/shared')
    }
  },
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      all: true,
      include: ['src/renderer/src/**/*.ts', 'src/shared/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        'src/renderer/src/env.d.ts',
        'src/renderer/src/main.ts',
        'src/shared/types.ts'
      ]
    }
  }
})
