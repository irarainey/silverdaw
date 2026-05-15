// Vitest config. Mirrors the renderer's path aliases from
// `tsconfig.web.json` so spec files can `import from '@/...'` and
// `'@shared/...'` the same way the runtime code does.
//
// Environment is `node` because today's specs only cover pure helpers
// (`lib/musicTime.ts`, `shared/bridge-protocol.ts` guards). When DOM /
// Vue-component tests show up we'll switch the relevant files to
// `// @vitest-environment jsdom` rather than forcing the whole suite
// through jsdom.

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
    environment: 'node'
  }
})
