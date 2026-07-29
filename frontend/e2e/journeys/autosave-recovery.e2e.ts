// J9a — Crash-recovery offers, and refuses, the right autosaves.
//
// Recovery is the app's answer to losing unsaved work, and its decision is made
// entirely from files on disk at startup: `main/ipc/autosaveHandlers.ts` scans the
// autosave root, reads each manifest, and offers only entries it judges genuine.
// Because `--user-data-dir` isolates that root, a spec can plant the exact state it
// wants and get a deterministic verdict — no crash, no waiting on the autosave
// timer, and access to cases a real crash could never be asked to produce.
//
// The negative cases here are race-free rather than merely likely to pass. The start
// screen's project buttons render only once `startupFlowComplete` is set, and App.vue
// sets that in `finishStartupFlow()` — which runs only after the recovery decision.
// So the picker appearing *is* proof that recovery ran and declined to offer
// anything; it is not a snapshot taken before the dialog had its chance.

import { expect, test } from '../fixtures/silverdaw'
import { makeAutosaveProjectJson } from '../helpers/autosaveFixtures'
import { libraryItem } from '../helpers/library'
import { copyProjectFixture, FIXTURE_AUDIO_FILE } from '../helpers/projectFixtures'
import { waitForStartupReady } from '../helpers/startup'
import { utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'

const RECOVERED_NAME = 'E2E Recovered Work'

const recoveryDialog = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog').filter({ hasText: 'Recover Unsaved Work' })

/**
 * Plants an original project plus an autosave that shadows it. The autosave is
 * stamped newer than the original because that age comparison is the rule recovery
 * applies, so leaving it to chance would leave the verdict to chance too.
 */
function seedShadowedProject(options: { pending?: boolean; autosaveOlder?: boolean } = {}) {
  const originalPath = copyProjectFixture()
  const audioPath = join(dirname(originalPath), FIXTURE_AUDIO_FILE)

  // Pin the original well into the past so "newer" and "older" are unambiguous.
  const originalTime = new Date(Date.now() - 60_000)
  utimesSync(originalPath, originalTime, originalTime)

  return {
    originalPath,
    bucket: {
      projectId: 'e2e-recovery-bucket',
      projectName: RECOVERED_NAME,
      originalPath,
      pending: options.pending ?? false,
      projectJson: makeAutosaveProjectJson({ audioPath, projectName: RECOVERED_NAME }),
      autosaveMtime: options.autosaveOlder
        ? new Date(Date.now() - 120_000)
        : new Date(Date.now() + 5_000)
    }
  }
}

test('an autosave newer than its project is offered and restores the unsaved work', async ({
  launchApp
}) => {
  const { bucket } = seedShadowedProject()
  const app = await launchApp({ autosaveBuckets: [bucket] })

  const dialog = recoveryDialog(app.page)
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await expect(dialog.getByText(RECOVERED_NAME)).toBeVisible()

  await dialog.getByRole('button', { name: 'Restore' }).click()

  // The library item proves the *autosave document* was loaded rather than a blank
  // session, and the project name proves it was the autosave rather than the
  // original it shadows — the original stores a different name entirely.
  await expect(libraryItem(app.page, FIXTURE_AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(app.page.getByRole('button', { name: RECOVERED_NAME })).toBeVisible()
})

test('a half-written autosave is never offered', async ({ launchApp }) => {
  // `pending` is set before the write and cleared after it, so a bucket still marked
  // pending is one the app died in the middle of. Offering it would hand the user a
  // truncated project in the name of protecting their work.
  const { bucket } = seedShadowedProject({ pending: true })
  const app = await launchApp({ autosaveBuckets: [bucket] })

  await waitForStartupReady(app.page)
  await expect(recoveryDialog(app.page)).toBeHidden()
})

test('an autosave older than its saved project is never offered', async ({ launchApp }) => {
  // The user saved after that autosave was written, so the autosave is stale. Offering
  // it invites someone to restore work older than the file they already have.
  const { bucket } = seedShadowedProject({ autosaveOlder: true })
  const app = await launchApp({ autosaveBuckets: [bucket] })

  await waitForStartupReady(app.page)
  await expect(recoveryDialog(app.page)).toBeHidden()
})

test('an autosave for a project that was never saved is always offered', async ({ launchApp }) => {
  // With no file behind it there is nothing to compare against and nowhere else the
  // work exists, so this is the case with the most to lose.
  const originalPath = copyProjectFixture()
  const app = await launchApp({
    autosaveBuckets: [
      {
        projectId: 'e2e-recovery-unsaved',
        projectName: RECOVERED_NAME,
        originalPath: null,
        projectJson: makeAutosaveProjectJson({
          audioPath: join(dirname(originalPath), FIXTURE_AUDIO_FILE),
          projectName: RECOVERED_NAME
        })
      }
    ]
  })

  const dialog = recoveryDialog(app.page)
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await expect(dialog.getByText('Untitled (never saved)')).toBeVisible()
})
