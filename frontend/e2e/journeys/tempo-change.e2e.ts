// J15 — Warp and project tempo.
//
// Tempo is the one edit that reaches every layer at once. Setting a BPM makes
// the engine re-stretch warped clips, move the clips already placed so the
// arrangement keeps its musical shape, and — since the range a user has
// selected covers bars rather than seconds — carry the timeline selection with
// them. The renderer applies the same rules locally so the timeline does not
// wait for a round trip (`projectStore.applyProjectBpm`), which means the two
// processes each hold their own copy of the arithmetic. Only this tier can
// prove they still agree, and only the saved document can prove what the engine
// actually did: the timeline is a canvas, so a warped, retimed clip has no DOM.
//
// The project tempo is never typed first. The first musical clip seeds it
// (ADR 0024 — one source-BPM resolver per process), so the journey reads the
// seeded value back and works from it. That also asserts the seed itself: the
// tempo the transport shows has to be the tempo the engine wrote to the file.
//
// Two ruler gestures are driven with a real mouse because no button reaches
// them: a press to move the playhead off the origin — the track import button
// imports at the playhead, and a clip parked at 0 retimes to 0 and proves
// nothing — and a drag to select a range. Both are gestures a user performs;
// nothing is read back from the canvas.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject, waitForStartupReady } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'
import { dragRulerRange, seekOnRuler } from '../helpers/timeline'

const PROJECT_NAME = 'E2E Tempo Change'
const AUDIO_FILE = 'e2e-tempo-change.wav'

/** Well clear of any tempo a two-second tone could be detected at. */
const TARGET_BPM = 150

/** Retimed positions are doubles on both sides, so compare to within 0.05 ms. */
const RETIME_TOLERANCE_DIGITS = 1

interface SavedProject {
  bpm: number
  clipOffsetMs: number
  clipWarpEnabled: boolean
  selectionStartMs: number
  selectionEndMs: number
}

interface ProjectNode {
  $type?: string
  $children?: ProjectNode[]
  [key: string]: unknown
}

/** Depth-first search for the first node of a type, since nesting is by container. */
function findNode(node: ProjectNode, type: string): ProjectNode | null {
  if (node.$type === type) return node
  for (const child of node.$children ?? []) {
    const found = findNode(child, type)
    if (found) return found
  }
  return null
}

/**
 * Reads the parts of the saved document this journey is about. Returns null
 * while the file is absent or mid-write, so callers can poll it.
 */
function readSavedProject(projectFile: string): SavedProject | null {
  let parsed: { project?: ProjectNode }
  try {
    parsed = JSON.parse(readFileSync(projectFile, 'utf8')) as { project?: ProjectNode }
  } catch {
    return null
  }
  const project = parsed.project
  if (!project) return null
  const clip = findNode(project, 'CLIP')
  if (!clip) return null
  return {
    bpm: Number(project['bpm']),
    clipOffsetMs: Number(clip['offsetMs']),
    clipWarpEnabled: clip['warpEnabled'] === true,
    selectionStartMs: Number(project['viewTimelineSelectionStartMs']),
    selectionEndMs: Number(project['viewTimelineSelectionEndMs'])
  }
}

test('a tempo change warps and retimes what is already placed', async ({ launchApp }) => {
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)
  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: 2 })

  const first = await launchApp()
  const { page } = first
  await startNewProject(page)
  await page.getByRole('button', { name: 'Add Track' }).click()

  // ── A clip, placed away from the origin ───────────────────────────────────
  await seekOnRuler(page, 150)

  await stubOpenDialog(first.electronApp, [wavPath])
  await page.getByTitle('Import audio file...').click()
  await expect(libraryItem(page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  // The button disables itself once its track holds a clip, which is the
  // DOM-observable proof that the clip landed on the timeline.
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })

  // ── The seeded tempo ──────────────────────────────────────────────────────
  // The field pulses with a "Detecting tempo…" tooltip until the engine reports
  // the first clip's tempo. Reading — or typing — before then would race the
  // seed and overwrite the value under test.
  const bpmField = page.getByLabel('Project BPM')
  await expect(bpmField).toHaveAttribute('title', /^Tempo/, { timeout: 30_000 })
  const seededBpm = Number(await bpmField.inputValue())
  expect(seededBpm).toBeGreaterThan(0)
  expect(seededBpm).not.toBe(TARGET_BPM)

  // ── A selected range, which covers bars rather than milliseconds ──────────
  await dragRulerRange(page, 40, 220)
  // Loop Selection is disabled without a range, so its enabled state is the
  // DOM signal that the drag produced one.
  await expect(page.getByTitle('Loop Selection (off) (L)')).toBeEnabled()

  // ── Save the "before" state and read it back ──────────────────────────────
  await stubSaveDialog(first.electronApp, chosenPath)
  await invokeMenuItem(page, 'File', 'Save As')
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()

  // The field shows two decimals while the engine keeps full precision, so the
  // agreement to assert is that the file rounds to what the transport displays.
  await expect
    .poll(() => Number((readSavedProject(projectFile)?.bpm ?? 0).toFixed(2)), {
      timeout: 30_000,
      message: `expected ${projectFile} to record the seeded tempo`
    })
    .toBe(seededBpm)

  const before = readSavedProject(projectFile)
  if (!before) throw new Error('saved project could not be read')

  // The clip sits where the playhead was, and the range where it was drawn.
  // Both have to be off the origin or the retime below would be unfalsifiable.
  expect(before.clipOffsetMs).toBeGreaterThan(0)
  expect(before.selectionStartMs).toBeGreaterThan(0)
  expect(before.selectionEndMs).toBeGreaterThan(before.selectionStartMs)
  // Nothing is warped yet: the project took its tempo from this very clip, so
  // there is no mismatch to correct.
  expect(before.clipWarpEnabled).toBe(false)

  // ── Change the tempo ──────────────────────────────────────────────────────
  await bpmField.fill(TARGET_BPM.toFixed(2))
  await bpmField.press('Enter')
  await expect(bpmField).toHaveValue(TARGET_BPM.toFixed(2))

  await invokeMenuItem(page, 'File', 'Save Ctrl+S') // disambiguated from "Save As…"
  await expect(page.getByLabel('Unsaved changes')).toBeHidden({ timeout: 30_000 })
  await expect
    .poll(() => readSavedProject(projectFile)?.bpm ?? 0, {
      timeout: 30_000,
      message: `expected ${projectFile} to record the new tempo`
    })
    .toBeCloseTo(TARGET_BPM, 2)

  const after = readSavedProject(projectFile)
  if (!after) throw new Error('saved project could not be read after the tempo change')

  // The clip is now at a tempo it was not recorded at, so the engine warps it.
  expect(after.clipWarpEnabled).toBe(true)

  // And everything musical keeps its bar: a faster project means less time to
  // the same beat, so positions scale by oldBpm / newBpm. The stored tempo is
  // used rather than the displayed one, which is rounded for the field.
  const scale = before.bpm / TARGET_BPM
  expect(after.clipOffsetMs).toBeCloseTo(before.clipOffsetMs * scale, RETIME_TOLERANCE_DIGITS)
  expect(after.selectionStartMs).toBeCloseTo(
    before.selectionStartMs * scale,
    RETIME_TOLERANCE_DIGITS
  )
  expect(after.selectionEndMs).toBeCloseTo(before.selectionEndMs * scale, RETIME_TOLERANCE_DIGITS)

  await closeSilverdaw(first)

  // ── A cold process reopens it ─────────────────────────────────────────────
  // The saved file only proves what was written. Reopening proves the engine can
  // restore a warped, retimed arrangement — it has to rebuild each follow-warp
  // ratio from the stored tempos, since a following clip stores no ratio of its own.
  const second = await launchApp()
  await waitForStartupReady(second.page)
  await stubOpenDialog(second.electronApp, [projectFile])
  await second.page.getByRole('button', { name: 'Open Project…' }).click()

  await expect(libraryItem(second.page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(second.page.getByLabel('Project BPM')).toHaveValue(TARGET_BPM.toFixed(2))
  await expect(second.page.getByTitle('Track already has a clip')).toBeDisabled()
  // The range comes back with the project, still enabling Loop Selection.
  await expect(second.page.getByTitle('Loop Selection (off) (L)')).toBeEnabled()
})
