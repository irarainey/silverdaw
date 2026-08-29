// J26 — Correcting a mis-detected tempo.
//
// The companion to J15. That journey proves a tempo CHANGE moves everything musical;
// this one proves a tempo CORRECTION moves nothing at all. The two edits touch the same
// two numbers, so only a tier that can read the saved document can tell them apart: the
// timeline is a canvas, and a clip that did not move has no DOM event to observe.
//
// The failure this guards against is the one that motivated ADR 0027. Detection is wrong
// by a few percent, the project tempo is seeded from it, and every route to fixing the
// number either rescaled the arrangement (the project tempo box) or left the two tempo
// facts disagreeing so the clip played fast or slow. The assertion is therefore
// deliberately absolute: the clip offset and the marker position must come back
// byte-identical while the file's tempo reads the corrected value.
//
// The project tempo is deliberately NOT part of this edit. Taking it from the first clip
// dropped is merely a convenience, with no linkage and no history, so the number is the
// user's rather than the file's and it stays put here — the transport box remains the
// place to change it.
//
// It also walks both surfaces that reach the one command, because the gap that made the
// feature hard to find was reachability rather than behaviour: the library context menu's
// "Edit BPM…" (a dedicated dialog, and where the correction is made here) and the Clip
// Editor opened on a timeline clip.

import { join } from 'node:path'

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { findNode, readProjectDocument } from '../helpers/projectDocument'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'
import { openClipEditorOnFirstTrack, seekOnRuler } from '../helpers/timeline'

const PROJECT_NAME = 'E2E Tempo Correction'
const AUDIO_FILE = 'e2e-tempo-correction.wav'

/**
 * A few percent away from anything a two-second tone detects at — the size of miss this
 * feature exists for. An octave error would be fixed by the ×2 / ÷2 buttons instead.
 */
const CORRECTED_BPM = 102.76

interface SavedProject {
  bpm: number
  sourceBpm: number
  clipOffsetMs: number
  markerPositionMs: number
}

function readSavedProject(projectFile: string): SavedProject | null {
  const project = readProjectDocument(projectFile)
  if (!project) return null
  const clip = findNode(project, 'CLIP')
  const library = findNode(project, 'LIBRARY')
  const item = library ? findNode(library, 'ITEM') : null
  const marker = findNode(project, 'MARKER')
  if (!clip || !item || !marker) return null
  return {
    bpm: Number(project['bpm']),
    sourceBpm: Number(item['bpm']),
    clipOffsetMs: Number(clip['offsetMs']),
    markerPositionMs: Number(marker['positionMs'])
  }
}

test('a tempo correction fixes the file tempo without moving anything', async ({ launchApp }) => {
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)
  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: 2 })

  const app = await launchApp()
  const { page } = app
  await startNewProject(page)
  await page.getByRole('button', { name: 'Add Track' }).click()

  // ── A clip and a marker, both away from the origin ────────────────────────
  // Anything at zero stays at zero under any arithmetic and would make the
  // "nothing moved" assertion unfalsifiable.
  await seekOnRuler(page, 150)
  await page.keyboard.press('m')

  await stubOpenDialog(app.electronApp, [wavPath])
  await page.getByTitle('Import audio file...').click()
  await expect(libraryItem(page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })

  // The field pulses until the engine reports the first clip's tempo and seeds the
  // project from it. Correcting before then would race the seed.
  const bpmField = page.getByRole('spinbutton', { name: 'Project BPM' })
  await expect(bpmField).toHaveAttribute('title', /^Tempo/, { timeout: 30_000 })
  const seededBpmText = await bpmField.inputValue()
  const seededBpm = Number(seededBpmText)
  expect(seededBpm).toBeGreaterThan(0)
  expect(seededBpm).not.toBe(CORRECTED_BPM)

  // ── Save the "before" state ───────────────────────────────────────────────
  await stubSaveDialog(app.electronApp, chosenPath)
  await invokeMenuItem(page, 'File', 'Save As')
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()
  await expect
    .poll(() => readSavedProject(projectFile)?.bpm ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0)

  const before = readSavedProject(projectFile)
  if (!before) throw new Error('saved project could not be read')
  expect(before.clipOffsetMs).toBeGreaterThan(0)
  expect(before.markerPositionMs).toBeGreaterThan(0)
  // The wrong number landed in both places, which is the whole problem.
  expect(before.sourceBpm).toBeCloseTo(before.bpm, 2)

  // ── Correct it ────────────────────────────────────────────────────────────
  // Through the library context menu's "Edit BPM…", which opens a dialog whose whole
  // job is this one number: it lands on the field with the old value selected, and its
  // Cancel/Save footer says plainly that nothing is written until Save is pressed.
  await libraryItem(page, AUDIO_FILE).click({ button: 'right' })
  await page.getByText('Edit BPM…').first().click()

  const bpmInput = page.getByTestId('edit-bpm-input')
  await expect(bpmInput).toBeVisible({ timeout: 30_000 })
  await expect(bpmInput).toBeFocused()
  await bpmInput.press('ControlOrMeta+a')
  await bpmInput.pressSequentially(CORRECTED_BPM.toFixed(2))

  // The consequences appear only once the typed number is a usable correction, and they
  // say in as many words that the project tempo is not part of this edit.
  await expect(page.getByTestId('tempo-correction-project-note')).toBeVisible()

  await page.getByTestId('edit-bpm-save').click()
  await expect(bpmInput).toBeHidden({ timeout: 30_000 })

  // The project tempo is the user's number and a correction is not evidence about it,
  // so it must still read what the seed put there.
  await expect(bpmField).toHaveValue(seededBpmText, { timeout: 30_000 })

  // The clip already on the timeline draws its grid from the corrected source.
  await openClipEditorOnFirstTrack(page, 200)
  await expect(page.getByLabel('Beat grid BPM')).toHaveValue(CORRECTED_BPM.toFixed(2), {
    timeout: 30_000
  })
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog', { name: AUDIO_FILE })).toBeHidden({ timeout: 30_000 })

  // ── Save the "after" state ────────────────────────────────────────────────
  await invokeMenuItem(page, 'File', 'Save', { exact: true }) // "Save As…" shares the prefix
  await expect(page.getByLabel('Unsaved changes')).toBeHidden({ timeout: 30_000 })
  await expect
    .poll(() => readSavedProject(projectFile)?.sourceBpm ?? 0, {
      timeout: 30_000,
      message: `expected ${projectFile} to record the corrected source tempo`
    })
    .toBeCloseTo(CORRECTED_BPM, 2)

  const after = readSavedProject(projectFile)
  if (!after) throw new Error('saved project could not be read after the correction')

  expect(after.sourceBpm).toBeCloseTo(CORRECTED_BPM, 2)
  // The project tempo is a separate fact and this edit is not about it.
  expect(after.bpm).toBeCloseTo(before.bpm, 2)

  // The invariant. Under a tempo CHANGE these would have scaled by before.bpm/102.76.
  expect(after.clipOffsetMs).toBe(before.clipOffsetMs)
  expect(after.markerPositionMs).toBe(before.markerPositionMs)

  await closeSilverdaw(app)
})
