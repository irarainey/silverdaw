// J19 — A warped clip exports for its stretched length.
//
// The regression this exists for shipped in 1.5.3: a stretched clip played and
// exported for its *dry* length, so the end of every warped clip was silently
// cut off the record the user came here to make. Export is the terminal act of
// the product, and truncated audio is the one defect a user cannot work around
// after the fact.
//
// It is also structurally invisible to every other tier. Stored clip duration is
// source time and stays that way; the timeline length is derived
// (`getClipEffectiveTiming`: `stretched = durationMs / tempoRatio`), and the
// offline `MixdownEngine` derives it again on its own side of the process
// boundary. A unit test can check either arithmetic in isolation and still miss
// the two disagreeing, which is exactly how the defect survived.
//
// The tempo is moved *down* from the seeded value on purpose. Ratio is
// project/source, so a lower project tempo makes the warped clip longer than its
// source — the direction a truncating render fails in. Raising it would leave the
// rendered file shorter than the source either way, and the assertion could not
// tell a correct stretch from a clip cut short.
//
// Nothing is assumed about tempo detection. The clip seeds the project tempo
// (ADR 0024), so the journey reads that back and derives its target from it,
// which keeps the stretch exact whatever a two-second tone happens to analyse at.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { findNode, readProjectDocument } from '../helpers/projectDocument'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

const PROJECT_NAME = 'E2E Export Warped'
const AUDIO_FILE = 'e2e-export-warped.wav'
const SOURCE_SECONDS = 2

/**
 * Fraction of the seeded tempo the project is moved to. 0.6 stretches the clip to
 * 1.67× its source length — far enough outside any plausible render slop that a
 * truncated export cannot land inside the tolerance below.
 */
const TEMPO_FRACTION = 0.6

/**
 * Rubber Band works in blocks and the render pads to whole frames, so the exported
 * length is close to the stretch rather than exact to the millisecond.
 */
const LENGTH_TOLERANCE = 0.1

interface WavSummary {
  readonly dataBytes: number
  readonly seconds: number
}

/**
 * Minimal RIFF/WAVE reader. Walking the chunks rather than assuming a 44-byte
 * header matters here: the engine is free to emit extra chunks, and a reader that
 * assumed a fixed offset would silently measure the wrong thing.
 */
function readWav(path: string): WavSummary {
  const buf = readFileSync(path)
  expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF')
  expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE')

  let byteRate = 0
  let dataBytes = 0
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString('ascii')
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') byteRate = buf.readUInt32LE(offset + 16)
    if (id === 'data') dataBytes = size
    offset += 8 + size + (size % 2)
  }

  expect(byteRate).toBeGreaterThan(0)
  return { dataBytes, seconds: dataBytes / byteRate }
}

interface SavedClip {
  /** Project tempo at full precision, rather than the two decimals the field shows. */
  projectBpm: number
  /** Stored clip duration, which stays in *source* time however the clip is warped. */
  durationMs: number
  offsetMs: number
  warpEnabled: boolean
}

function readSavedClip(projectFile: string): SavedClip | null {
  const project = readProjectDocument(projectFile)
  if (!project) return null
  const clip = findNode(project, 'CLIP')
  if (!clip) return null
  return {
    projectBpm: Number(project['bpm']),
    durationMs: Number(clip['durationMs']),
    offsetMs: Number(clip['offsetMs']),
    warpEnabled: clip['warpEnabled'] === true
  }
}

test('a warped clip exports for its stretched length', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)
  const outputPath = join(makeTrackedTempDir('mixdown'), 'E2E Warped Mixdown.wav')
  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: SOURCE_SECONDS })

  await startNewProject(page)
  await page.getByRole('button', { name: 'Add Track' }).click()

  // Imported at the playhead, which is still at the origin. The clip does not
  // land at exactly zero — a clip against the start of the timeline is nudged so
  // its first beat sits on a grid line — so the export length is the clip's
  // offset plus its stretched length, and the offset is read back rather than
  // assumed.
  await stubOpenDialog(electronApp, [wavPath])
  await page.getByTitle('Import audio file...').click()
  await expect(libraryItem(page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })

  // ── The seeded tempo, then a slower one ───────────────────────────────────
  // The field pulses "Detecting tempo…" until the engine reports the first clip's
  // tempo; reading or typing before then would race the seed.
  const bpmField = page.getByLabel('Project BPM')
  await expect(bpmField).toHaveAttribute('title', /^Tempo/, { timeout: 30_000 })
  const seededBpm = Number(await bpmField.inputValue())
  expect(seededBpm).toBeGreaterThan(0)

  const targetBpm = Number((seededBpm * TEMPO_FRACTION).toFixed(2))
  await bpmField.fill(targetBpm.toFixed(2))
  await bpmField.press('Enter')
  await expect(bpmField).toHaveValue(targetBpm.toFixed(2))

  // ── What the project now says the clip is ─────────────────────────────────
  await stubSaveDialog(electronApp, chosenPath)
  await invokeMenuItem(page, 'File', 'Save As')
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()

  await expect
    .poll(() => readSavedClip(projectFile)?.warpEnabled ?? false, {
      timeout: 30_000,
      message: `expected ${projectFile} to record a warped clip`
    })
    .toBe(true)

  const saved = readSavedClip(projectFile)
  if (!saved) throw new Error('saved project could not be read')

  // Stored duration is source time — the stretch lives in the ratio, which is why
  // a render that trusts the stored figure cuts the clip short.
  expect(saved.durationMs / 1000).toBeCloseTo(SOURCE_SECONDS, 1)

  // `stretched = durationMs / tempoRatio`, `tempoRatio = project / source`
  // (`getClipEffectiveTiming`). The saved tempo is used rather than the displayed
  // one, which is rounded for the field.
  const tempoRatio = saved.projectBpm / seededBpm
  const stretchedSeconds = saved.durationMs / 1000 / tempoRatio
  const expectedSeconds = saved.offsetMs / 1000 + stretchedSeconds

  // What a render that ignored the warp would produce: the clip's own end, in
  // source time. Every assertion below is really about the gap between these two.
  const dryEndSeconds = (saved.offsetMs + saved.durationMs) / 1000

  // Guards the journey against testing nothing: if tempo detection ever made the
  // stretch negligible, the length assertions below would pass on a dry render.
  expect(expectedSeconds).toBeGreaterThan(dryEndSeconds * 1.3)

  // ── Export it ─────────────────────────────────────────────────────────────
  await invokeMenuItem(page, 'File', 'Export Mixdown')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox').first().fill(outputPath)

  // "Trim to end of last clip" is what ties the artefact's length to the clip, so
  // the exported file has to answer the same question the project does: where does
  // this warped clip end?
  await dialog.getByRole('radio', { name: 'Trim to end of last clip' }).check()
  await dialog.getByRole('button', { name: 'Export' }).click()

  // Polling the file rather than the progress dialog keeps the wait tied to the
  // artefact; rendering is offline work in the engine, so allow generous time.
  await expect
    .poll(
      () => {
        try {
          return readFileSync(outputPath).length
        } catch {
          return 0
        }
      },
      { timeout: 60_000, message: `expected a mixdown at ${outputPath}` }
    )
    .toBeGreaterThan(1024)

  // Let the engine finish flushing before parsing, so the chunk walk reads a
  // complete document rather than a partial one.
  await expect(page.getByRole('alertdialog')).toBeHidden({ timeout: 60_000 })

  const wav = readWav(outputPath)
  expect(wav.dataBytes).toBeGreaterThan(0)

  // The claim: the render covers the clip as the project describes it, stretched.
  expect(wav.seconds).toBeGreaterThan(expectedSeconds * (1 - LENGTH_TOLERANCE))
  expect(wav.seconds).toBeLessThan(expectedSeconds * (1 + LENGTH_TOLERANCE))

  // Stated separately and against the dry end, because this is the regression
  // itself: a render that fell back to the stored duration would land there, and
  // would still be comfortably inside a tolerance expressed only as a ratio.
  expect(wav.seconds).toBeGreaterThan(dryEndSeconds * 1.2)
})
