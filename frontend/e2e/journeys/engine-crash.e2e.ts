// J8 — The audio engine crashes mid-session and the app recovers.
//
// Silverdaw's two-process split (ADR 0002) means the engine can die while the UI
// lives on. `backendSupervisor` respawns it and `engineRecovery` reloads the
// project into the new engine, gating the UI behind an overlay while it does.
// None of that can be exercised without really killing a real process, so this
// is the only tier that can cover it at all.
//
// The engine is killed by PID, resolved strictly as a child of this test's own
// Electron main process, so a developer's separately running Silverdaw is never
// touched.
//
// Recovery is only meaningful if the user's work comes back with it, so the
// project state is asserted after the overlay clears, and the app is then driven
// further to prove the new engine is genuinely attached rather than merely
// spawned.

import { expect, test } from '../fixtures/silverdaw'
import { findBackendPids, killBackend } from '../helpers/backendProcess'
import { stubSaveDialog } from '../helpers/dialogs'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'
import { join } from 'node:path'

const PROJECT_NAME = 'E2E Engine Crash'
const EMPTY_TRACK = 'Import audio file...'

test('the app recovers when the audio engine is killed mid-session', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)

  // Ask Electron for its own main-process pid rather than using the pid Playwright
  // launched: they are not always the same process, and the engine is spawned by
  // main.
  const mainPid = (await electronApp.evaluate(() => process.pid)) as number
  if (!Number.isInteger(mainPid)) throw new Error('could not resolve Electron main pid')

  await startNewProject(page)

  // Give recovery something to restore, and save it: recovery reloads the
  // project from its file, so unsaved-only state would not prove the reload.
  await page.getByRole('button', { name: 'Add Track' }).click()
  await page.getByRole('button', { name: 'Add Track' }).click()
  await expect(page.getByTitle(EMPTY_TRACK)).toHaveCount(2)

  await stubSaveDialog(electronApp, chosenPath)
  await invokeMenuItem(page, 'File', 'Save As')
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()

  // ── Kill the engine ───────────────────────────────────────────────────────
  const overlay = page.getByRole('dialog', { name: 'Reconnecting to the audio engine…' })
  await expect(overlay).toBeHidden()

  const killedPid = killBackend(mainPid)

  // The overlay is the user-visible contract: edits and transport are gated
  // while the engine is gone.
  await expect(overlay).toBeVisible({ timeout: 30_000 })

  // ── Recovery ──────────────────────────────────────────────────────────────
  // Respawn uses exponential backoff, so allow generous time before failing.
  await expect(overlay).toBeHidden({ timeout: 90_000 })

  // A different process is now serving the app.
  const pidsAfter = findBackendPids(mainPid)
  expect(pidsAfter.length).toBe(1)
  expect(pidsAfter[0]).not.toBe(killedPid)

  // The user's work came back with it.
  await expect(page.getByTitle(EMPTY_TRACK)).toHaveCount(2)
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible()

  // And the new engine is really attached, not just running: a further edit has
  // to be accepted and reported back through the bridge.
  await page.getByRole('button', { name: 'Add Track' }).click()
  await expect(page.getByTitle(EMPTY_TRACK)).toHaveCount(3, { timeout: 30_000 })
})
