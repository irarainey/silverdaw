// Vitest config. Mirrors the renderer's path aliases from
// `tsconfig.web.json` so test files can `import from '@/...'`,
// `'@shared/...'` and `'@main/...'` the same way the runtime code does.
//
// Tests live under `frontend/tests/`, mirroring the `src/` layout
// (`tests/renderer`, `tests/main`, `tests/shared`) and are named
// `*.test.ts`. They reference the code under test exclusively through the
// path aliases below rather than relative paths into `src/`.
//
// Environment is `node` because today's tests cover pure helpers and
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
      '@shared': here('src/shared'),
      '@main': here('src/main')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      all: true,
      include: ['src/renderer/src/**/*.ts', 'src/shared/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'tests/**',
        'src/**/*.d.ts',
        'src/renderer/src/env.d.ts',
        'src/renderer/src/main.ts',
        'src/shared/types.ts'
      ]
    }
  }
})
