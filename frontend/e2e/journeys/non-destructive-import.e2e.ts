// J7 — Importing onto a track never rewrites the user's source audio.
//
// Non-destructive editing is the promise the whole library model rests on: a
// file a user drags in is theirs, and Silverdaw records references and metadata
// rather than editing the bytes. That guarantee spans main (which copies media
// into the project folder), the renderer (which registers the item), and the
// JUCE engine (which writes the project file) — no single tier can prove it.
//
// The route in is the track header's import button rather than a drag from the
// library. Placement is native HTML5 drag-and-drop onto a PixiJS canvas, which
// a test can only fake by synthesising the events the browser would normally
// generate; that would assert the implementation rather than the user. The
// track import button reaches the same end state through a real click.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

const PROJECT_NAME = 'E2E Non Destructive'
const AUDIO_FILE = 'e2e-non-destructive.wav'

/** Hash of a file's bytes — the only assertion that can prove audio was not rewritten. */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('importing onto a track leaves the source file byte-identical', async ({ launchApp }) => {
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFolder = join(projectsDir, PROJECT_NAME)
  const projectFile = join(projectFolder, `${PROJECT_NAME}.silverdaw`)

  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: 2 })
  const originalHash = sha256(wavPath)

  const app = await launchApp()
  await startNewProject(app.page)

  // A new project starts empty — "Add a track or open a project to start" — so the
  // track has to be created before anything can be imported onto it.
  await app.page.getByRole('button', { name: 'Add Track' }).click()

  // The import button is disabled once its track holds a clip, so its own tooltip
  // is the observable proof that the import landed on the timeline, with no canvas
  // inspection needed.
  const trackImport = app.page.getByTitle('Import audio file...')
  await expect(trackImport).toBeEnabled()

  await stubOpenDialog(app.electronApp, [wavPath])
  await trackImport.click()

  await expect(libraryItem(app.page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(app.page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })

  await stubSaveDialog(app.electronApp, chosenPath)
  await invokeMenuItem(app.page, 'File', 'Save As')

  await expect(app.page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(app.page.getByLabel('Unsaved changes')).toBeHidden()
  await expect
    .poll(
      () => {
        try {
          return readFileSync(projectFile, 'utf8').includes(AUDIO_FILE)
        } catch {
          return false
        }
      },
      { timeout: 30_000, message: `expected ${projectFile} to reference ${AUDIO_FILE}` }
    )
    .toBe(true)

  // Release the engine's handle before reading the project folder.
  await closeSilverdaw(app)

  // The claim itself: the file the user picked is untouched. Silverdaw records
  // references and metadata, so a regression here would be a silent and
  // unrecoverable edit to someone's own audio.
  expect(sha256(wavPath)).toBe(originalHash)

  // And the project points back at that file rather than holding an edited copy.
  // A media path is only rewritten to a project-relative one when it already sits
  // inside the project folder, so an import from elsewhere is stored absolute —
  // which is exactly why the original has to survive intact.
  const saved = readFileSync(projectFile, 'utf8')
  expect(saved).toContain(JSON.stringify(wavPath).slice(1, -1))
})
