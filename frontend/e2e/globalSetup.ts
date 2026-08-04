// Playwright global setup — refuse to run against missing or stale bundles.
//
// The e2e fixture launches the *built* Electron app (`out/main/index.js`), not
// the sources. `pnpm test:e2e` builds first, so the bundles always match. But
// invoking the runner directly — `pnpm test:e2e:only`, or the ▶ button in an
// editor's Testing panel — skips that build, so a run would silently exercise
// whatever was last compiled. A green tick against stale code is worse than a
// red one, so fail loudly and say how to fix it instead.

import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository `frontend/` directory, derived from this file's location. */
const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Entry points produced by `electron-vite build`, one per process. */
const BUILT_ENTRIES = [
  join(FRONTEND_ROOT, 'out', 'main', 'index.js'),
  join(FRONTEND_ROOT, 'out', 'preload', 'index.cjs'),
  join(FRONTEND_ROOT, 'out', 'renderer', 'index.html')
] as const

/** Inputs whose modification invalidates those entry points. */
const SOURCE_PATHS = [
  join(FRONTEND_ROOT, 'src'),
  join(FRONTEND_ROOT, 'electron.vite.config.ts')
] as const

const BUILD_HINT =
  'Run `pnpm --dir frontend build` (VS Code: the "frontend: build" task), then re-run. ' +
  '`pnpm test:e2e` does this for you.'

/** Newest mtime in a file or directory tree, or 0 when the path is absent. */
function newestMtimeMs(path: string): number {
  const stats = statSync(path, { throwIfNoEntry: false })
  if (stats === undefined) return 0
  if (!stats.isDirectory()) return stats.mtimeMs

  let newest = stats.mtimeMs
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtimeMs(join(path, entry.name)))
  }
  return newest
}

export default function assertBundlesAreFresh(): void {
  const missing = BUILT_ENTRIES.filter(
    (entry) => statSync(entry, { throwIfNoEntry: false }) === undefined
  )
  if (missing.length > 0) {
    throw new Error(`Electron bundles are missing:\n  ${missing.join('\n  ')}\n${BUILD_HINT}`)
  }

  // Compare the *oldest* output against the *newest* input: if any one bundle
  // predates any one source, at least one process is running stale code.
  const builtAtMs = Math.min(...BUILT_ENTRIES.map((entry) => statSync(entry).mtimeMs))
  const sourceAtMs = Math.max(...SOURCE_PATHS.map(newestMtimeMs))

  if (sourceAtMs > builtAtMs) {
    throw new Error(
      `Electron bundles are older than the frontend sources, so this run would test ` +
        `stale code.\n${BUILD_HINT}`
    )
  }
}
