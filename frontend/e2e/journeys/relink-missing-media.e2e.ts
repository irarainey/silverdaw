// J18 — A project whose audio has moved offers to relink it.
//
// The data-loss journey for the library model. Silverdaw records references
// rather than copies (ADR 0007), and an import from outside the project folder
// is stored as an absolute path — so a user who reorganises their samples
// folder reopens a project pointing at files that are no longer there. Whether
// that is a recoverable inconvenience or a lost arrangement depends entirely on
// this path working.
//
// It is also a cross-process contract that no other tier can prove. The engine
// decides a source is missing while serialising state — `ProjectStateLibrary`
// and `ProjectStateSerialization` stat each resolved path and mark the item and
// its clips `unresolved` — and the renderer turns that flag into the dialog
// (`useMissingFileRelink`). A Vitest spec can only assert the renderer's half
// against a hand-made flag, which is exactly the agreement at risk.
//
// The audio is moved to a different folder under the *same* file name, which is
// what reorganising a library actually does. It also keeps the assertions
// unambiguous: the library row is addressed by its displayed name, so a rename
// would leave a passing test unable to say whether the row it found was the
// relinked item or a stale one.
//
// The relink is only believed after a save and a cold reopen. Clearing the
// dialog proves the renderer accepted the new path; only reopening from a fresh
// process proves the engine wrote it to the project file rather than holding it
// in memory — and a rebind that never reaches disk is a defect that would look
// fixed in every manual test.

import { readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem, libraryItemTempo } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject, waitForStartupReady } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

const PROJECT_NAME = 'E2E Relink'
const AUDIO_FILE = 'e2e-relink.wav'

const relinkDialog = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog').filter({ hasText: 'Missing Audio Files' })

test('a project whose audio has moved can be relinked and stays relinked', async ({ launchApp }) => {
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)

  const originalWav = createToneWav({ fileName: AUDIO_FILE, seconds: 2 })

  // ── Build a project that references audio outside its own folder ──────────
  const first = await launchApp()
  await startNewProject(first.page)
  await first.page.getByRole('button', { name: 'Add Track' }).click()

  // Imported onto a track rather than only into the library, so the missing
  // source has a clip depending on it — the case where a user stands to lose an
  // arrangement rather than just a list entry.
  await stubOpenDialog(first.electronApp, [originalWav])
  await first.page.getByTitle('Import audio file...').click()
  await expect(libraryItem(first.page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(first.page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })

  // Tempo detection writes into the project when it lands, so saving before then
  // would leave the project dirty again the moment it finishes.
  await expect(libraryItemTempo(first.page, AUDIO_FILE)).toBeVisible({ timeout: 60_000 })

  await stubSaveDialog(first.electronApp, chosenPath)
  await invokeMenuItem(first.page, 'File', 'Save As')
  await expect(first.page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({
    timeout: 30_000
  })
  await expect(first.page.getByLabel('Unsaved changes')).toBeHidden()

  // Release the engine's handle on the audio before moving it.
  await closeSilverdaw(first)

  // A media path is stored relative only when it sits inside the project folder,
  // so an import from elsewhere is absolute — which is precisely why moving the
  // file breaks the reference this journey then repairs.
  expect(readFileSync(projectFile, 'utf8')).toContain(JSON.stringify(originalWav).slice(1, -1))

  // ── The user reorganises their audio ──────────────────────────────────────
  const movedWav = join(makeTrackedTempDir('relocated'), basename(originalWav))
  renameSync(originalWav, movedWav)

  // ── Reopening surfaces the loss and offers the repair ─────────────────────
  const second = await launchApp()
  await waitForStartupReady(second.page)
  await stubOpenDialog(second.electronApp, [projectFile])
  await second.page.getByRole('button', { name: 'Open Project…' }).click()

  const dialog = relinkDialog(second.page)
  await expect(dialog).toBeVisible({ timeout: 30_000 })

  // The path it reports is the one that broke, and the clip tally is what tells a
  // user how much of their arrangement is at stake — a dialog that opened but
  // named the wrong file would be worse than none at all.
  await expect(dialog.getByText(AUDIO_FILE, { exact: true })).toBeVisible()
  await expect(dialog.getByTitle(originalWav, { exact: true })).toBeVisible()
  await expect(dialog.getByText('Used by 1 clip')).toBeVisible()

  // The picker behind "Locate file…" is `chooseAudioFile`, which goes through the
  // same `showOpenDialog` seam every other journey stubs.
  await stubOpenDialog(second.electronApp, [movedWav])
  await dialog.getByRole('button', { name: 'Locate file…' }).click()

  // The dialog closes itself once nothing is unresolved, so it disappearing is the
  // engine confirming the rebind rather than the renderer assuming it.
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(libraryItem(second.page, AUDIO_FILE)).toBeVisible()

  // ── The repair is durable ─────────────────────────────────────────────────
  // Exact, because "Save" is a prefix of "Save As…" in the same menu — and Save
  // rather than Save As is the point: the relink has to persist into the project
  // file the user already has, not into a fresh copy.
  await invokeMenuItem(second.page, 'File', 'Save', { exact: true })
  await expect(second.page.getByLabel('Unsaved changes')).toBeHidden({ timeout: 30_000 })
  await closeSilverdaw(second)

  const saved = readFileSync(projectFile, 'utf8')
  expect(saved).toContain(JSON.stringify(movedWav).slice(1, -1))
  expect(saved).not.toContain(JSON.stringify(originalWav).slice(1, -1))

  // And a cold session opens it without ever mentioning a missing file, which is
  // the only way to show the relink survived as project state rather than as a
  // renderer-side patch over a still-broken reference.
  const third = await launchApp()
  await waitForStartupReady(third.page)
  await stubOpenDialog(third.electronApp, [projectFile])
  await third.page.getByRole('button', { name: 'Open Project…' }).click()

  await expect(libraryItem(third.page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(relinkDialog(third.page)).toBeHidden()
})
