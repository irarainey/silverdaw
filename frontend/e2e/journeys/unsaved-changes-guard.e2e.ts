// J11 — The unsaved-changes guard protects work in progress.
//
// This is the data-loss journey. Every other regression in the suite costs time;
// a broken guard costs a user their session. The prompt sits between a dirty
// project and three destructive-ish outcomes, and each branch has to be proven
// separately because they fail in different directions: Cancel that proceeds
// anyway loses work, Don't Save that refuses to proceed strands the user, and
// Save that proceeds before the write lands loses work silently.
//
// Cancel is the branch most likely to rot. It is the only one where the correct
// behaviour is for nothing to happen, which is also indistinguishable from the
// prompt simply being broken — so it asserts that the project is still open *and*
// still dirty, not merely that the app did not crash.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Locator } from '@playwright/test'

import { expect, test, type SilverdawApp } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem, libraryItems } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

const AUDIO_FILE = 'e2e-unsaved-guard.wav'

/**
 * Brings the app to a project with unsaved changes. Importing is used to dirty it
 * because it is the same route a user takes and leaves an observable trace in the
 * library, so a later assertion can tell "project still open" from "project gone".
 */
async function makeDirtyProject(app: SilverdawApp): Promise<void> {
  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: 1 })
  await startNewProject(app.page)
  await stubOpenDialog(app.electronApp, [wavPath])
  await app.page
    .getByRole('button', { name: 'Import', description: 'Import audio files into the library' })
    .click()
  await expect(libraryItem(app.page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(app.page.getByLabel('Unsaved changes')).toBeVisible()
}

/** The guard's own dialog, distinguished by its title rather than by being "a dialog". */
function unsavedPrompt(app: SilverdawApp): Locator {
  return app.page.getByRole('dialog').filter({ hasText: 'Save Changes to' })
}

test('cancelling the unsaved-changes prompt leaves the project open and dirty', async ({
  launchApp
}) => {
  const app = await launchApp()
  await makeDirtyProject(app)

  await invokeMenuItem(app.page, 'File', 'New Project')
  const prompt = unsavedPrompt(app)
  await expect(prompt).toBeVisible()

  await prompt.getByRole('button', { name: 'Cancel' }).click()
  await expect(prompt).toBeHidden()

  // Nothing happened, which is the whole point: the work is still here and still
  // unsaved. Asserting only that the library survived would pass even if the guard
  // had quietly marked the project clean and armed a silent loss later.
  await expect(libraryItem(app.page, AUDIO_FILE)).toBeVisible()
  await expect(app.page.getByLabel('Unsaved changes')).toBeVisible()
})

test('discarding unsaved changes proceeds to a new project', async ({ launchApp }) => {
  const app = await launchApp()
  await makeDirtyProject(app)

  await invokeMenuItem(app.page, 'File', 'New Project')
  const prompt = unsavedPrompt(app)
  await expect(prompt).toBeVisible()

  await prompt.getByRole('button', { name: "Don't Save" }).click()
  await expect(prompt).toBeHidden()

  // The new project really replaced the old one rather than the prompt just closing.
  await expect(libraryItems(app.page)).toHaveCount(0, { timeout: 30_000 })
})

test('saving from the unsaved-changes prompt writes the project before proceeding', async ({
  launchApp
}) => {
  const projectsDir = makeTrackedTempDir('projects')
  const projectName = 'E2E Guard Save'
  const chosenPath = join(projectsDir, `${projectName}.silverdaw`)
  const projectFile = join(projectsDir, projectName, `${projectName}.silverdaw`)

  const app = await launchApp()
  await makeDirtyProject(app)

  await invokeMenuItem(app.page, 'File', 'New Project')
  const prompt = unsavedPrompt(app)
  await expect(prompt).toBeVisible()

  // The project has never been saved, so Save has to route through Save As.
  // Matched exactly: "Save" is a substring of "Don't Save".
  await stubSaveDialog(app.electronApp, chosenPath)
  await prompt.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(prompt).toBeHidden()

  // The file is the assertion, not the UI: the guarantee is that the work reached
  // disk before the project it belonged to was replaced.
  await expect
    .poll(
      () => existsSync(projectFile) && readFileSync(projectFile, 'utf8').includes(AUDIO_FILE),
      { timeout: 30_000, message: `expected ${projectFile} to contain the imported audio` }
    )
    .toBe(true)

  await expect(libraryItems(app.page)).toHaveCount(0, { timeout: 30_000 })
})
