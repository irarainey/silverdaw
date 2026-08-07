// J9b — The autosave the app really writes is one recovery really accepts.
//
// J9a proves the *reader*: it plants buckets and asserts which ones recovery
// offers. That deliberately says nothing about the writer, and the two halves
// are owned by different processes and different modules — the renderer's
// `lib/autosave.ts` writes the manifest and drives `PROJECT_AUTOSAVE`, while
// main's `ipc/autosaveHandlers.ts` decides what is recoverable. A unit spec
// covers the writer against a mocked IPC surface, so between them nothing
// establishes that what the writer produces is something the reader will take.
// A drift on either side leaves the app quietly writing autosaves it will never
// offer back, which fails exactly when the user needs it and never before.
//
// This journey does not wait on the autosave interval. `restartTimer()` ticks
// immediately whenever a project becomes dirty ("so newly dirty projects get a
// prompt first snapshot"), so the artefact is a consequence of the edit rather
// than of elapsed time — the spec polls for the bucket appearing, which is a
// filesystem assertion, not a timing one.
//
// The project is saved *before* the edit under test on purpose. An explicit save
// clears the current bucket, so anything found afterwards was written by the
// tick that the edit triggered, and the second track exists only in the autosave
// — never in the file on disk. That gap is what makes the restore meaningful:
// recovering work already saved would prove nothing.

import { readFileSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { AUTOSAVE_FILENAME, AUTOSAVE_MANIFEST_FILENAME } from '../helpers/autosaveFixtures'
import { stubSaveDialog } from '../helpers/dialogs'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

import type { Locator, Page } from '@playwright/test'

const PROJECT_NAME = 'E2E Autosave Write'

/** Empty tracks each render their own import button, so this counts tracks. */
const emptyTracks = (page: Page): Locator => page.getByTitle('Import audio file...')

const recoveryDialog = (page: Page): Locator =>
  page.getByRole('dialog').filter({ hasText: 'Recover Unsaved Work' })

interface WrittenBucket {
  projectId: string
  manifest: { originalPath: string | null; projectName: string; pending: boolean }
}

/**
 * Finds a completed autosave bucket under a profile.
 *
 * The bucket id is deliberately not recomputed here. It is a hash of the project
 * path (`deriveProjectIdFromPath`), and reimplementing that would let this spec
 * agree with a writer that had started bucketing work somewhere recovery never
 * looks. Scanning the root instead asks the same question recovery asks.
 */
function findWrittenBucket(userDataDir: string): WrittenBucket | null {
  const root = join(userDataDir, 'autosave')
  let ids: string[]
  try {
    ids = readdirSync(root)
  } catch {
    return null
  }
  for (const projectId of ids) {
    try {
      // Both files, because a bucket with only a manifest is the half-written
      // state recovery is required to refuse.
      readFileSync(join(root, projectId, AUTOSAVE_FILENAME))
      const manifest = JSON.parse(
        readFileSync(join(root, projectId, AUTOSAVE_MANIFEST_FILENAME), 'utf8')
      ) as WrittenBucket['manifest']
      if (manifest.pending) continue
      return { projectId, manifest }
    } catch {
      continue
    }
  }
  return null
}

/** Number of tracks in a saved project document. */
function savedTrackCount(projectFile: string): number {
  const doc = JSON.parse(readFileSync(projectFile, 'utf8')) as {
    project: { $children: { $type: string }[] }
  }
  return doc.project.$children.filter((child) => child.$type === 'TRACK').length
}

test('an edit is autosaved and the written bucket is offered back after a restart', async ({
  launchApp
}) => {
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)

  const first = await launchApp()
  const { page } = first
  await startNewProject(page)

  await page.getByRole('button', { name: 'Add Track' }).click()
  await expect(emptyTracks(page)).toHaveCount(1)

  // Saving both gives the project a path — autosave is bucketed by it — and
  // clears any bucket standing behind it, so what appears later is unambiguous.
  await stubSaveDialog(first.electronApp, chosenPath)
  await invokeMenuItem(page, 'File', 'Save As')
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()
  expect(savedTrackCount(projectFile)).toBe(1)

  // ── The edit that must survive a crash ────────────────────────────────────
  await page.getByRole('button', { name: 'Add Track' }).click()
  await expect(emptyTracks(page)).toHaveCount(2)
  await expect(page.getByLabel('Unsaved changes')).toBeVisible()

  await expect
    .poll(() => findWrittenBucket(first.userDataDir) !== null, {
      timeout: 30_000,
      message: `expected a completed autosave bucket under ${join(first.userDataDir, 'autosave')}`
    })
    .toBe(true)

  const bucket = findWrittenBucket(first.userDataDir)
  if (!bucket) throw new Error('autosave bucket disappeared after being found')

  // The manifest has to name the file this work belongs to, because that is what
  // recovery compares against and what it offers the user by name. A bucket that
  // lost its `originalPath` would still be offered — as work that was never
  // saved anywhere, which is a different and misleading claim.
  expect(bucket.manifest.originalPath).toBe(projectFile)
  expect(bucket.manifest.projectName).toBe(PROJECT_NAME)
  expect(bucket.manifest.pending).toBe(false)

  // The work is in the autosave and nowhere else.
  expect(savedTrackCount(projectFile)).toBe(1)

  // Recovery only offers a bucket more than 500 ms newer than the file it
  // shadows. Here the save and the edit are milliseconds apart, so that margin
  // would otherwise be left to how fast the run is scheduled. Ageing the *saved
  // file* pins the comparison without touching the autosave, which is the
  // artefact under test — and the age rule itself is already covered by J9a.
  const aged = new Date(Date.now() - 60_000)
  utimesSync(projectFile, aged, aged)

  // Keep the profile: the bucket in it is the evidence the next session reads.
  await closeSilverdaw(first, { keepProfile: true })

  // ── A new session is offered the work back ────────────────────────────────
  const second = await launchApp({ userDataDir: first.userDataDir })

  const dialog = recoveryDialog(second.page)
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  // Exact, because the dialog lists the shadowed file's path beneath the name and
  // that path contains the project name too.
  await expect(dialog.getByText(PROJECT_NAME, { exact: true })).toBeVisible()

  await dialog.getByRole('button', { name: 'Restore' }).click()

  // Two tracks against a one-track file on disk: the restored session is the
  // autosave's state rather than the saved project's, which is the whole point
  // of the feature. It stays dirty for the same reason — the work still has
  // nowhere permanent to live until the user saves it.
  await expect(emptyTracks(second.page)).toHaveCount(2, { timeout: 30_000 })
  await expect(second.page.getByLabel('Unsaved changes')).toBeVisible()
  expect(savedTrackCount(projectFile)).toBe(1)
})
