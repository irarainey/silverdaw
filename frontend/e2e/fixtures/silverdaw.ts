// Launch fixture for the Electron end-to-end tier.
//
// Owns one thing: getting a fully isolated Silverdaw instance up, handing the
// spec its main-process handle and renderer page, and tearing it down without
// leaking processes or state onto the developer's machine.
//
// Isolation matters more here than in a normal web app. Silverdaw persists
// preferences, window state, an MRU list, and autosaves, and CONTEXT.md makes
// backward compatibility of that state a CRITICAL constraint. A test run must
// therefore never read or write the real profile, or a green run could be
// hiding a migration bug (or worse, corrupt a developer's saved settings).
//
// `--user-data-dir` relocates all of that persisted state, and with it Electron's
// single-instance lock, so a spec can run happily while a normal Silverdaw is
// open on the same machine.
//
// Known gap: the `Silverdaw/{Logs,Diagnostics,Models}` tree hangs off
// `app.getPath('home')` (main/preferences.ts), and Electron resolves `home` from
// the Windows shell API rather than `USERPROFILE`, so it cannot be redirected
// from the environment. A run therefore appends to the real diagnostics log and
// shares the downloaded-models cache. Both are append-only or cache-like, so no
// project state is at risk — but isolating them would need a production seam
// (an env override for the user-folder root), which is a separate proposal.

import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUTOSAVE_FILENAME,
  AUTOSAVE_MANIFEST_FILENAME,
  type AutosaveBucketSeed
} from '../helpers/autosaveFixtures'
import { forgetTrackedTempDirs, makeTrackedTempDir, removeTrackedTempDirs } from '../helpers/tempDirs'

/** Repository `frontend/` directory, derived from this file's location. */
const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Built main-process entry point — `pnpm build` must have run. */
export const MAIN_ENTRY = join(FRONTEND_ROOT, 'out', 'main', 'index.js')

export interface SilverdawApp {
  readonly electronApp: ElectronApplication
  readonly page: Page
  /** Isolated `userData` root (preferences, autosave, MRU, single-instance lock). */
  readonly userDataDir: string
  /** Always-on diagnostics directory, as resolved by the running app. */
  readonly diagnosticsDir: string
  /** Renderer console output, captured from launch for failure diagnosis. */
  readonly consoleLog: string[]
}

export interface LaunchOptions {
  /**
   * MRU entries to seed into the throwaway profile, newest first. Recents are
   * persisted in `preferences.json` (main/preferences.ts), so a spec that needs
   * the start screen's recent list has to plant it before launch — an isolated
   * profile starts empty by design.
   */
  recentProjects?: { path: string; name: string }[]
  /**
   * Crash-recovery buckets to plant under `<userData>/autosave/`. Startup scans
   * that root and decides purely from what it finds, so seeding is how a spec
   * chooses the exact recovery state under test. See helpers/autosaveFixtures.ts.
   */
  autosaveBuckets?: AutosaveBucketSeed[]
  /**
   * Extra `preferences.json` keys to plant before launch, merged over the
   * harness defaults. Use this to stand up a legacy or partial document and
   * prove the real loader reads it — the merge rules themselves are pure
   * functions covered by tests/main/preferences.test.ts, so only reach for
   * this when the round trip through the file is the point.
   */
  preferences?: Record<string, unknown>
}

/** Writes the seeded autosave buckets into a profile before the app reads them. */
function seedAutosaveBuckets(userDataDir: string, buckets: AutosaveBucketSeed[]): void {
  for (const bucket of buckets) {
    const dir = join(userDataDir, 'autosave', bucket.projectId)
    mkdirSync(dir, { recursive: true })

    const autosavePath = join(dir, AUTOSAVE_FILENAME)
    writeFileSync(autosavePath, bucket.projectJson, 'utf8')
    if (bucket.autosaveMtime) {
      utimesSync(autosavePath, bucket.autosaveMtime, bucket.autosaveMtime)
    }

    writeFileSync(
      join(dir, AUTOSAVE_MANIFEST_FILENAME),
      JSON.stringify(
        {
          projectId: bucket.projectId,
          originalPath: bucket.originalPath,
          projectName: bucket.projectName,
          savedAtIso: bucket.savedAtIso ?? new Date().toISOString(),
          pending: bucket.pending ?? false,
          appVersion: 'e2e'
        },
        null,
        2
      ),
      'utf8'
    )
  }
}

/**
 * Launches Silverdaw with a throwaway profile and waits for the renderer's
 * first window. Deliberately does not wait for engine readiness — *when* the
 * engine becomes ready is itself under test, so a spec asserts that.
 */
export async function launchSilverdaw(options: LaunchOptions = {}): Promise<SilverdawApp> {
  // Tracked as well as removed in `closeSilverdaw`, so a run that crashes before
  // teardown still gets swept up rather than leaving a profile behind.
  const userDataDir = makeTrackedTempDir('profile')

  // Seed the throwaway profile with diagnostic logging on. The renderer mirrors
  // its logger to the console only when this is enabled, and that narrative is
  // often the sole trace of a silently-swallowed cross-process failure. Written
  // as a partial document on purpose: the loader merges it over the defaults,
  // so this also exercises the read-old/write-latest preferences path.
  writeFileSync(
    join(userDataDir, 'preferences.json'),
    JSON.stringify({
      debug: { loggingEnabled: true },
      ...(options.recentProjects ? { recentProjects: options.recentProjects } : {}),
      ...(options.preferences ?? {})
    }),
    'utf8'
  )

  if (options.autosaveBuckets?.length) {
    seedAutosaveBuckets(userDataDir, options.autosaveBuckets)
  }

  // `ELECTRON_RENDERER_URL` is set only by `electron-vite dev`. A value
  // inherited from an interactive shell would point the window at a dev server
  // that isn't running instead of the built renderer bundle, so it is dropped
  // rather than overridden — Playwright's env map takes strings only.
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'ELECTRON_RENDERER_URL'
    )
  )
  // Selects the backend build tree in an unpackaged run (main/index.ts).
  env['SILVERDAW_BACKEND_CONFIG'] = process.env['SILVERDAW_BACKEND_CONFIG'] ?? 'Debug'

  const electronApp = await electron.launch({
    // The switch precedes the entry point so Chromium consumes it rather than
    // the app seeing it as an argv entry.
    args: [`--user-data-dir=${userDataDir}`, MAIN_ENTRY],
    cwd: FRONTEND_ROOT,
    env
  })

  const page = await electronApp.firstWindow()

  // The renderer mirrors its own logger to the console, so capturing it gives a
  // renderer-side narrative to sit alongside the main/backend diagnostics log.
  // Errors here are frequently the only trace of a silently-swallowed failure.
  const consoleLog: string[] = []
  page.on('console', (message) => consoleLog.push(`[${message.type()}] ${message.text()}`))
  page.on('pageerror', (error) => consoleLog.push(`[pageerror] ${error.message}`))

  // Asked of the app rather than recomputed here, so the fixture cannot drift
  // from however `main/preferences.ts` resolves the location.
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))

  return {
    electronApp,
    page,
    userDataDir,
    diagnosticsDir: join(home, 'Silverdaw', 'Diagnostics'),
    consoleLog
  }
}

/**
 * Reads the always-on diagnostics log the app writes for every launch. This is
 * the cross-process record — main lifecycle, startup phase timings, and the
 * backend's own piped stdout/stderr — so attaching it to a failure explains
 * both processes at once.
 */
export async function readDiagnosticsLogs(diagnosticsDir: string): Promise<string> {
  let entries: string[]
  try {
    entries = await readdir(diagnosticsDir)
  } catch {
    return `(no diagnostics directory at ${diagnosticsDir})`
  }

  const logs = entries.filter((name) => name.endsWith('.log'))
  if (logs.length === 0) return '(diagnostics directory contained no .log files)'

  const sections = await Promise.all(
    logs.map(async (name) => {
      const body = await readFile(join(diagnosticsDir, name), 'utf8').catch(
        (err: unknown) => `(unreadable: ${err instanceof Error ? err.message : String(err)})`
      )
      return `───── ${name} ─────\n${body}`
    })
  )
  return sections.join('\n\n')
}

/**
 * Shuts an app down and removes its temporary profile.
 *
 * `win.on('close')` vetoes the first attempt and asks the renderer to run its
 * unsaved-changes guard, so a plain `close()` on a dirty project blocks forever
 * waiting for a human. Destroying the windows skips the veto while still
 * letting `window-all-closed` run, which is what kills the backend and flushes
 * preferences — so shutdown stays realistic.
 *
 * Safe to call twice: a round-trip journey closes its first app mid-test to
 * prove the saved file survives a real restart, and teardown then sweeps up.
 */
export async function closeSilverdaw(app: SilverdawApp): Promise<void> {
  await app.electronApp
    .evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.destroy()
    })
    .catch(() => undefined)
  await app.electronApp.close().catch(() => undefined)
  // Ignore residual file locks so a cleanup failure can never mask the real
  // assertion result.
  rmSync(app.userDataDir, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * Provides launched apps and guarantees teardown. Exposed as a factory because
 * a round-trip journey needs two sequential launches — save in one process,
 * reopen in the next — which is the only way to prove that persisted state
 * survives a real restart rather than an in-memory reset.
 */
export const test = base.extend<{
  launchApp: (options?: LaunchOptions) => Promise<SilverdawApp>
  silverdaw: SilverdawApp
  tempArtifacts: void
}>({
  // Sweeps up the temp directories the helpers synthesise (imported audio, saved
  // projects, fixture copies). Auto, so a journey cannot forget, and declared
  // before `launchApp` so it tears down last — after the app has exited and
  // released its handles on the project folder.
  //
  // Kept on failure, the same bargain as `trace: 'retain-on-failure'`: the saved
  // project that broke a round-trip is usually the most direct evidence there is,
  // and deleting it would throw that away at exactly the wrong moment.
  tempArtifacts: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      await use()
      if (testInfo.status === testInfo.expectedStatus) {
        removeTrackedTempDirs()
      } else {
        forgetTrackedTempDirs()
      }
    },
    { auto: true }
  ],

  // Empty destructuring is Playwright's required form for a fixture with no
  // dependencies. It also matters here: naming a built-in such as `page` would
  // opt this tier into the browser fixtures, which need a downloaded browser.
  // eslint-disable-next-line no-empty-pattern
  launchApp: async ({}, use, testInfo) => {
    const launched: SilverdawApp[] = []

    await use(async (options?: LaunchOptions) => {
      const app = await launchSilverdaw(options)
      launched.push(app)
      return app
    })

    if (launched.length > 0 && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('silverdaw-diagnostics.log', {
        body: await readDiagnosticsLogs(launched[0]!.diagnosticsDir),
        contentType: 'text/plain'
      })
      // One attachment per launch, because a round-trip failure usually needs
      // the second session's narrative, not the first's.
      for (const [index, app] of launched.entries()) {
        await testInfo.attach(`renderer-console-${index + 1}.log`, {
          body: app.consoleLog.join('\n') || '(no renderer console output)',
          contentType: 'text/plain'
        })
      }
    }

    for (const app of launched) {
      await closeSilverdaw(app)
    }
  },

  silverdaw: async ({ launchApp }, use) => {
    await use(await launchApp())
  }
})

export { expect } from '@playwright/test'
