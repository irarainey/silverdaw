// J21 — Mixer state: named, levelled, panned, muted and soloed, through a restart.
//
// The mix is the part of a project a user cannot rebuild from memory. Track
// names, fader levels, pan positions and the mute/solo flags are set once and
// then trusted for the rest of a session, so a value that silently fails to
// reach the file — or reaches the wrong track — is discovered only when the
// project is reopened, long after the work that produced it.
//
// Three tracks, not one. Every value here is per-track, and the classic defect
// is not a value lost but a value applied to the neighbouring track; with a
// single track an off-by-one is unobservable. The controls are addressed by
// position for the same reason: the header rows render in track order, so
// reading the third slider and finding the second track's value is a failure
// this journey should catch rather than route around.
//
// Mute is set before solo deliberately. Soloing disables every other track's
// mute button (`TrackHeaderPanel.vue`), so the reverse order could not press it
// — and the state after the restart, where a muted track reports itself
// suppressed by another track's solo, is exactly the case where a persisted
// mute flag could go missing without anyone noticing.
//
// Track FX are left out. The rack's modules carry no stable accessible name, and
// adding one purely so a test could find it would be a test-only hook in
// production code.

import { join } from 'node:path'

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { invokeMenuItem } from '../helpers/menu'
import { findNodes, readProjectDocument } from '../helpers/projectDocument'
import { startNewProject, waitForStartupReady } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

import type { Locator, Page } from '@playwright/test'

const PROJECT_NAME = 'E2E Mixer'
const TRACK_NAMES = ['Drums', 'Bass', 'Vox'] as const

/** Typed into the gain field, and expected back as "-6.0 dB". */
const GAIN_DB = -6
const GAIN_LINEAR = 10 ** (GAIN_DB / 20)

/** Left of centre, and clear of the slider's centre detent. */
const PAN_VALUE = -0.5

// Header rows are rendered in track order, so the nth control belongs to the nth
// track. Each accessor deliberately matches all three rows and is indexed by the
// caller.
const nameCells = (page: Page): Locator => page.getByTitle(/ — click to rename$/)
const gainFields = (page: Page): Locator => page.getByTitle(/double-click to type a dB value/)
const panSliders = (page: Page): Locator => page.getByLabel('Track pan')
const muteButtons = (page: Page): Locator => page.getByRole('button', { name: 'M', exact: true })
const soloButtons = (page: Page): Locator => page.getByRole('button', { name: 'S', exact: true })
const masterVolume = (page: Page): Locator => page.getByLabel('Master volume')
const masterVolumeReadout = (page: Page): Locator => page.getByTitle(/^Master volume:/)

/** The inline editors focus themselves on open, so this is the one on screen. */
const openEditor = (page: Page): Locator => page.locator('input:focus')

async function renameTrack(page: Page, index: number, name: string): Promise<void> {
  await nameCells(page).nth(index).click()
  const editor = openEditor(page)
  await editor.fill(name)
  await editor.press('Enter')
}

async function setGainDb(page: Page, index: number, db: number): Promise<void> {
  await gainFields(page).nth(index).dblclick()
  const editor = openEditor(page)
  await editor.fill(String(db))
  await editor.press('Enter')
}

interface SavedTrack {
  name: string
  gain: number
  pan: number
  muted: boolean
  soloed: boolean
}

/** The mix as the file records it, with absent flags read as "off". */
function readSavedMix(projectFile: string): { masterVolume: number; tracks: SavedTrack[] } | null {
  const project = readProjectDocument(projectFile)
  if (!project) return null
  return {
    masterVolume: Number(project['masterVolume']),
    tracks: findNodes(project, 'TRACK').map((track) => ({
      name: String(track['name'] ?? ''),
      gain: Number(track['gain']),
      pan: Number(track['pan'] ?? 0),
      muted: track['muted'] === true,
      soloed: track['soloed'] === true
    }))
  }
}

test('track names, levels, pan and mute/solo survive a restart', async ({ launchApp }) => {
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)

  const first = await launchApp()
  const { page } = first
  await startNewProject(page)

  const addTrack = page.getByRole('button', { name: 'Add Track' })
  for (let i = 0; i < TRACK_NAMES.length; i += 1) await addTrack.click()
  await expect(nameCells(page)).toHaveCount(TRACK_NAMES.length)

  // ── Names ─────────────────────────────────────────────────────────────────
  for (const [index, name] of TRACK_NAMES.entries()) await renameTrack(page, index, name)
  await expect(nameCells(page)).toHaveText([...TRACK_NAMES])

  // ── Level and pan, on the first track only ────────────────────────────────
  await setGainDb(page, 0, GAIN_DB)
  await expect(gainFields(page).nth(0)).toHaveAttribute('title', /^Volume -6\.0 dB/)

  await panSliders(page).nth(0).fill(String(PAN_VALUE))
  // Read back rather than predicted: the pan readout's wording is the product's
  // to choose, and this journey is about the value surviving, not its spelling.
  const panTitle = await panSliders(page).nth(0).getAttribute('title')
  expect(panTitle).not.toBeNull()

  // Untouched neighbours stay untouched — the off-by-one check.
  await expect(gainFields(page).nth(1)).toHaveAttribute('title', /^Volume \+0\.0 dB/)
  await expect(panSliders(page).nth(1)).toHaveValue('0')

  // ── Mute, then solo ───────────────────────────────────────────────────────
  await muteButtons(page).nth(1).click()
  await expect(muteButtons(page).nth(1)).toHaveAttribute('title', 'Unmute')
  await expect(muteButtons(page).nth(0)).toHaveAttribute('title', 'Mute')

  await soloButtons(page).nth(2).click()
  await expect(soloButtons(page).nth(2)).toHaveAttribute('title', 'Unsolo')
  // Solo is global: every other track now reports itself suppressed, and its
  // mute button is out of reach.
  await expect(muteButtons(page).nth(0)).toBeDisabled()
  await expect(muteButtons(page).nth(1)).toHaveAttribute('title', 'Muted by solo on another track')

  // ── Master level ──────────────────────────────────────────────────────────
  await masterVolume(page).fill('0.5')
  const masterTitle = await masterVolumeReadout(page).getAttribute('title')
  expect(masterTitle).not.toBeNull()

  // ── What reaches the file ─────────────────────────────────────────────────
  await stubSaveDialog(first.electronApp, chosenPath)
  await invokeMenuItem(page, 'File', 'Save As')
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()

  await expect
    .poll(() => readSavedMix(projectFile)?.tracks.map((t) => t.name) ?? [], {
      timeout: 30_000,
      message: `expected ${projectFile} to record three named tracks`
    })
    .toEqual([...TRACK_NAMES])

  const saved = readSavedMix(projectFile)
  if (!saved) throw new Error('saved project could not be read')
  const [drums, bass, vox] = saved.tracks as [SavedTrack, SavedTrack, SavedTrack]

  expect(drums.gain).toBeCloseTo(GAIN_LINEAR, 3)
  expect(drums.pan).toBeCloseTo(PAN_VALUE, 2)
  expect(drums.muted).toBe(false)
  expect(drums.soloed).toBe(false)

  // The flags landed on the tracks that were clicked, and nowhere else.
  expect(bass.muted).toBe(true)
  expect(bass.soloed).toBe(false)
  expect(bass.gain).toBeCloseTo(1, 3)
  expect(bass.pan).toBeCloseTo(0, 2)

  expect(vox.soloed).toBe(true)
  expect(vox.muted).toBe(false)

  expect(saved.masterVolume).toBeGreaterThan(0)
  expect(saved.masterVolume).toBeLessThan(1)

  await closeSilverdaw(first)

  // ── And comes back in a process that set none of it ───────────────────────
  const second = await launchApp()
  await waitForStartupReady(second.page)
  await stubOpenDialog(second.electronApp, [projectFile])
  await second.page.getByRole('button', { name: 'Open Project…' }).click()

  await expect(nameCells(second.page)).toHaveText([...TRACK_NAMES], { timeout: 30_000 })
  await expect(gainFields(second.page).nth(0)).toHaveAttribute('title', /^Volume -6\.0 dB/)
  await expect(panSliders(second.page).nth(0)).toHaveAttribute('title', panTitle ?? '')
  await expect(gainFields(second.page).nth(1)).toHaveAttribute('title', /^Volume \+0\.0 dB/)

  // Solo is restored, so the mute set before it can only show through as the
  // suppressed state — which is why the file, not the button, carries the proof.
  await expect(soloButtons(second.page).nth(2)).toHaveAttribute('title', 'Unsolo')
  await expect(muteButtons(second.page).nth(1)).toHaveAttribute(
    'title',
    'Muted by solo on another track'
  )
  await expect(masterVolumeReadout(second.page)).toHaveAttribute('title', masterTitle ?? '')
})
