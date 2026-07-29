// J14 — Importing assets from another saved project.
//
// The one journey where two projects exist at once. It reads a *different*
// project's document and media from disk while a project is already open, which
// is a distinct risk from opening or saving: the engine has to inspect a foreign
// project without adopting it, and the assets have to attach to the current
// project rather than to the one they came from.
//
// The source project is built live rather than kept as a frozen fixture. The
// Import from Project dialog only offers stems and samples, and a sample is a
// derived asset the engine mints from a clip — freezing one would freeze an
// engine output that the engine itself is free to change, so the fixture would
// rot silently. Building it through the UI also means the journey exercises the
// real producer of the artefact it later consumes.
//
// The save and reopen at the end are the point. Landing a row in the library only
// proves the dialog worked; reopening from a cold process proves the asset really
// joined the project rather than borrowing the source project's state in memory.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { closeSilverdaw, expect, test, type SilverdawApp } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem, libraryItems } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject, waitForStartupReady } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

const SOURCE_PROJECT_NAME = 'E2E Import Source'
const TARGET_PROJECT_NAME = 'E2E Import Target'
const AUDIO_FILE = 'e2e-import-source.wav'

/**
 * Turns an imported source into a library sample and returns the name the engine
 * gave it.
 *
 * Samples are only reachable from a *clip*, and a clip only exists once the user
 * has selected a region in the clip editor, so the drag is unavoidable rather
 * than incidental. It drives real mouse input over the waveform host; nothing is
 * read back from the canvas, and the assertions either side are DOM state.
 */
const createSampleFromSource = async (app: SilverdawApp, sourceName: string): Promise<string> => {
  const { page } = app

  await libraryItem(page, sourceName).dblclick()
  const saveSelection = page.getByRole('button', { name: 'Save Selection to Library' })
  await expect(saveSelection).toBeVisible({ timeout: 30_000 })

  // Disabled until a region exists, which is what makes the drag observable.
  await expect(saveSelection).toBeDisabled()
  const box = await page.locator('.cursor-crosshair').first().boundingBox()
  if (!box) throw new Error('clip editor waveform host has no bounding box')
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 20 })
  await page.mouse.up()
  await expect(saveSelection).toBeEnabled()

  await saveSelection.click()
  await expect(saveSelection).toBeHidden({ timeout: 30_000 })
  await expect(libraryItems(page)).toHaveCount(2)

  // The clip's name embeds its start time, so read it back rather than deriving it.
  const clipName = await page
    .locator('[data-testid="library-item"]')
    .nth(1)
    .getAttribute('data-library-item-name')
  if (!clipName) throw new Error('saved clip row has no name')

  await libraryItem(page, clipName).click({ button: 'right' })
  await page.getByText('Save as Sample (Simple)').first().click()
  await expect(libraryItems(page)).toHaveCount(3, { timeout: 60_000 })

  const sampleName = await page
    .locator('[data-testid="library-item"]')
    .nth(2)
    .getAttribute('data-library-item-name')
  if (!sampleName) throw new Error('saved sample row has no name')
  return sampleName
}

test('assets import from another project and survive a reopen', async ({ launchApp }) => {
  // The dialog lists projects found in the configured project folder, so the source
  // has to be reachable from there rather than chosen through a file picker.
  const projectsRoot = makeTrackedTempDir('import-sources')
  const sourceChosenPath = join(projectsRoot, `${SOURCE_PROJECT_NAME}.silverdaw`)

  const targetDir = makeTrackedTempDir('projects')
  const targetChosenPath = join(targetDir, `${TARGET_PROJECT_NAME}.silverdaw`)
  const targetFile = join(targetDir, TARGET_PROJECT_NAME, `${TARGET_PROJECT_NAME}.silverdaw`)

  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: 2 })

  // ── First session: build the source project and save it ───────────────────
  const source = await launchApp({
    preferences: { paths: { defaultProjectDir: projectsRoot } }
  })
  await startNewProject(source.page)

  await stubOpenDialog(source.electronApp, [wavPath])
  await source.page
    .getByRole('button', { name: 'Import', description: 'Import audio files into the library' })
    .click()
  await expect(libraryItem(source.page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })

  const sampleName = await createSampleFromSource(source, AUDIO_FILE)

  await stubSaveDialog(source.electronApp, sourceChosenPath)
  await invokeMenuItem(source.page, 'File', 'Save As')
  await expect(source.page.getByRole('button', { name: SOURCE_PROJECT_NAME })).toBeVisible({
    timeout: 30_000
  })
  await expect(source.page.getByLabel('Unsaved changes')).toBeHidden()
  await closeSilverdaw(source)

  // ── Second session: import that sample into a fresh project ───────────────
  const target = await launchApp({
    preferences: { paths: { defaultProjectDir: projectsRoot } }
  })
  await startNewProject(target.page)
  await expect(libraryItems(target.page)).toHaveCount(0)

  await invokeMenuItem(target.page, 'File', 'Import from Project')
  const dialog = target.page.getByRole('dialog').filter({ hasText: 'Import from Project' })
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: SOURCE_PROJECT_NAME }).click()
  const asset = dialog.getByRole('checkbox', { name: sampleName })
  await expect(asset).toBeVisible({ timeout: 30_000 })
  await asset.check()

  // Matched on the leading word: the label carries a live selection count.
  await dialog.getByRole('button', { name: /^Import/ }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  await expect(libraryItem(target.page, sampleName)).toBeVisible({ timeout: 30_000 })
  await expect(libraryItems(target.page)).toHaveCount(1)

  await stubSaveDialog(target.electronApp, targetChosenPath)
  await invokeMenuItem(target.page, 'File', 'Save As')
  await expect(target.page.getByRole('button', { name: TARGET_PROJECT_NAME })).toBeVisible({
    timeout: 30_000
  })
  await expect(target.page.getByLabel('Unsaved changes')).toBeHidden()

  await expect
    .poll(
      () => {
        try {
          return readFileSync(targetFile, 'utf8').includes(sampleName)
        } catch {
          return false
        }
      },
      { timeout: 30_000, message: `expected ${targetFile} to reference ${sampleName}` }
    )
    .toBe(true)

  await closeSilverdaw(target)

  // ── Third session: the imported asset is really part of the project ───────
  const reopened = await launchApp()
  await waitForStartupReady(reopened.page)
  await stubOpenDialog(reopened.electronApp, [targetFile])
  await reopened.page.getByRole('button', { name: 'Open Project…' }).click()

  await expect(libraryItem(reopened.page, sampleName)).toBeVisible({ timeout: 30_000 })
  await expect(libraryItems(reopened.page)).toHaveCount(1)

  // The import must copy the media into the target project rather than referencing
  // the source, or the asset would break the moment the source project moved.
  expect(existsSync(targetFile)).toBe(true)
  expect(readFileSync(targetFile, 'utf8')).not.toContain(SOURCE_PROJECT_NAME)
})


