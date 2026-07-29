// Tracks the temporary directories a journey creates so teardown can remove them.
//
// The artefacts themselves are the point: this tier only proves anything because
// the engine decodes a real WAV and writes a real project folder. But they are
// bulky and they accumulate — a saved project carries its imported audio, peaks,
// and metadata — so a developer's TEMP should not collect hundreds of abandoned
// projects as the price of running the suite.
//
// Registration is module-level rather than passed through a fixture because the
// helpers are plain functions a spec calls directly, and threading a collector
// through every call site would put bookkeeping in front of the journey. Playwright
// runs fixtures and spec bodies in the same worker process, so the auto fixture in
// `fixtures/silverdaw.ts` sees exactly what these helpers recorded.

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Shared prefix, so a directory left by a crashed run is still identifiable. */
const PREFIX = 'silverdaw-e2e-'

const tracked = new Set<string>()

/**
 * Creates a temporary directory that teardown will remove.
 *
 * `label` names the kind of artefact (`audio`, `projects`, …) and appears in the
 * directory name, so anything that does survive a crash says what produced it.
 */
export function makeTrackedTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${PREFIX}${label}-`))
  tracked.add(dir)
  return dir
}

/**
 * Removes every tracked directory.
 *
 * Failures are swallowed deliberately. The engine can still hold a handle on a
 * project folder moments after shutdown, and a cleanup problem must never fail an
 * otherwise-passing journey or mask a real assertion result — the worst case is the
 * leak that existed before this helper.
 */
export function removeTrackedTempDirs(): void {
  for (const dir of tracked) {
    try {
      // Retries cover the engine releasing its handles on a project folder.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Intentionally ignored; see above.
    }
  }
  tracked.clear()
}

/** Stops tracking without deleting, so a failed run's evidence survives. */
export function forgetTrackedTempDirs(): void {
  tracked.clear()
}
