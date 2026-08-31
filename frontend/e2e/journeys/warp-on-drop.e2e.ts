// J16 — A clip lands warped when the project already has a tempo.
//
// The counterpart to J15: there, the tempo moved under clips that were already
// placed; here, the clip arrives into a tempo that is already established. The
// decision is made at drop time by the renderer and applied by the engine, and
// it is the behaviour users notice most — a clip that lands at its own tempo
// plays against everything else on the timeline.
//
// The tempo is typed before anything is imported, which is what makes the
// journey unambiguous. It also pins a second guarantee in the same run: a
// hand-set tempo is established, so the clip that follows must warp to it
// rather than seed its own tempo over it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem, libraryItemTempo } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

const PROJECT_NAME = 'E2E Warp On Drop'
const AUDIO_FILE = 'e2e-warp-on-drop.wav'

/** Far enough from any tempo a two-second tone detects at to demand a real stretch. */
const PROJECT_BPM = 150

test('a clip imported into a project with a tempo warps to it', async ({ launchApp }) => {
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)
  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: 2 })

  const app = await launchApp()
  const { page } = app
  await startNewProject(page)

  // The tempo field is disabled until the project has somewhere to put audio.
  await page.getByRole('button', { name: 'Add Track' }).click()
  const bpmField = page.getByLabel('Project BPM')
  await bpmField.fill(PROJECT_BPM.toFixed(2))
  await bpmField.press('Enter')
  await expect(bpmField).toHaveValue(PROJECT_BPM.toFixed(2))

  await stubOpenDialog(app.electronApp, [wavPath])
  await page.getByTitle('Import audio file...').click()
  await expect(libraryItem(page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })

  // A hand-set tempo is established, so the clip must warp to it rather than
  // re-seed the project from its own detected tempo.
  await expect(bpmField).toHaveValue(PROJECT_BPM.toFixed(2))

  // Tempo detection writes into the project when it lands, so saving before then
  // would leave the project dirty again the moment it finishes.
  await expect(libraryItemTempo(page, AUDIO_FILE)).toBeVisible({ timeout: 60_000 })

  await stubSaveDialog(app.electronApp, chosenPath)
  await invokeMenuItem(page, 'File', 'Save As')
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()

  // Warp state has no DOM — the timeline is a canvas — so the engine's own
  // document is what proves the clip was warped rather than merely placed.
  await expect
    .poll(
      () => {
        try {
          return /"warpEnabled"\s*:\s*true/.test(readFileSync(projectFile, 'utf8'))
        } catch {
          return false
        }
      },
      { timeout: 30_000, message: `expected ${projectFile} to record a warped clip` }
    )
    .toBe(true)

  // Warp is only meaningful against a tempo, so the tempo has to have survived
  // the import too — an unnoticed re-seed would leave a warp of exactly 1×.
  const saved = JSON.parse(readFileSync(projectFile, 'utf8')) as {
    project?: Record<string, unknown>
  }
  expect(Number(saved.project?.['bpm'])).toBeCloseTo(PROJECT_BPM, 2)
})
