// J20 — Markers: dropped at the playhead, toggled off, persisted, cleared.
//
// Markers are how a user keeps their place in an arrangement, and they are the
// only project state reached almost entirely by keyboard: `M` toggles one at the
// playhead (`useAppKeyboardShortcuts` → `toggleMarkerAt(transport.positionMs)`),
// and Edit ▸ Clear All Markers removes the lot. 1.5.0 added the Clear All command
// and changed markers to land at the exact playhead position rather than the
// nearest beat, and shipped two marker defects in the same release — none of it
// covered here until now.
//
// Nothing is read from the canvas. Markers have no DOM of their own, so the
// journey leans on the Edit menu item as the observable signal: it is enabled
// exactly when the project holds at least one marker
// (`useAppTitleBarController`), which makes it a live count of marker state that
// a user can see. What actually reached the project is then read from the saved
// document.
//
// The toggle is exercised in the middle because it is the half most likely to
// rot: `M` on an existing marker must *remove* it rather than stack a second one
// at the same spot, and a regression there is invisible until the user tries to
// undo their own keystroke.

import { join } from 'node:path'

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { menuItem, openMenu, closeMenu, invokeMenuItem } from '../helpers/menu'
import { findNodes, readProjectDocument } from '../helpers/projectDocument'
import { startNewProject, waitForStartupReady } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'
import { seekOnRuler } from '../helpers/timeline'

import type { Locator, Page } from '@playwright/test'

const PROJECT_NAME = 'E2E Markers'

/** Two ruler positions, far enough apart that no snap could merge them. */
const FIRST_MARKER_PX = 150
const SECOND_MARKER_PX = 320

/**
 * The Edit item is enabled exactly when the project holds a marker, so it doubles
 * as the DOM-observable answer to "are there any markers?" — which markers
 * themselves, being canvas, cannot give.
 */
const clearAllMarkers = (page: Page): Locator => menuItem(page, 'Clear All Markers')

/**
 * Opens the Edit menu, retrying the open itself. The menu bar rebuilds on every
 * project-state change and drops whatever was open, so an open issued right
 * after a marker keypress can be discarded before it is read. Only the open is
 * retried — the item's state is asserted afterwards, so a wrong state still
 * fails.
 */
async function openEditMenu(page: Page): Promise<Locator> {
  await expect(async () => {
    // Escape first, so an already-open menu is not toggled shut by the click.
    await closeMenu(page)
    await openMenu(page, 'Edit')
    await expect(clearAllMarkers(page)).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  return clearAllMarkers(page)
}

/** Reads the item's state and closes the menu, leaving nothing open behind it. */
async function expectMarkersPresent(page: Page, present: boolean): Promise<void> {
  await expect(async () => {
    const item = await openEditMenu(page)
    if (present) await expect(item).toBeEnabled({ timeout: 1_000 })
    else await expect(item).toBeDisabled({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  await closeMenu(page)
}

/** Marker positions in the saved document, in document order. */
function savedMarkerPositions(projectFile: string): number[] | null {
  const project = readProjectDocument(projectFile)
  if (!project) return null
  return findNodes(project, 'MARKER').map((marker) => Number(marker['positionMs']))
}

test('markers drop at the playhead, toggle off, survive a restart, and clear', async ({
  launchApp
}) => {
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)

  const first = await launchApp()
  const { page } = first
  await startNewProject(page)

  // The ruler only accepts a seek once the project has a timeline to seek in.
  await page.getByRole('button', { name: 'Add Track' }).click()

  // Asserting the empty case first is what gives every "enabled" below its
  // meaning: an item that were always enabled would otherwise look like proof.
  await expectMarkersPresent(page, false)

  // ── Dropped at the playhead ───────────────────────────────────────────────
  await seekOnRuler(page, FIRST_MARKER_PX)
  await page.keyboard.press('m')
  await expectMarkersPresent(page, true)

  // ── Toggled off, then back on ─────────────────────────────────────────────
  // The playhead has not moved, so this second press must find the marker it
  // just made and remove it. A regression that stacked a second marker at the
  // same position would leave the item enabled and pass unnoticed.
  await page.keyboard.press('m')
  await expectMarkersPresent(page, false)

  await page.keyboard.press('m')
  await expectMarkersPresent(page, true)

  // ── A second marker, elsewhere ────────────────────────────────────────────
  await seekOnRuler(page, SECOND_MARKER_PX)
  await page.keyboard.press('m')

  await stubSaveDialog(first.electronApp, chosenPath)
  await invokeMenuItem(page, 'File', 'Save As')
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()

  await expect
    .poll(() => savedMarkerPositions(projectFile)?.length ?? 0, {
      timeout: 30_000,
      message: `expected ${projectFile} to record two markers`
    })
    .toBe(2)

  const saved = savedMarkerPositions(projectFile)
  if (!saved) throw new Error('saved project could not be read')
  const [firstMs, secondMs] = saved as [number, number]

  // Both are off the origin and distinct, and they run in the order the playhead
  // visited them — the toggle above left exactly one marker behind, not two at
  // the same spot, and the second landed further along the timeline.
  expect(firstMs).toBeGreaterThan(0)
  expect(secondMs).toBeGreaterThan(firstMs)

  // The ruler maps pixels to time linearly from the origin, so two seeks at a
  // known pixel ratio must produce positions in that same ratio. That is what
  // pins the markers to the *exact* playhead position: anything snapping them to
  // the nearest beat would land them on grid lines and break the proportion.
  expect(secondMs / firstMs).toBeCloseTo(SECOND_MARKER_PX / FIRST_MARKER_PX, 1)

  await closeSilverdaw(first)

  // ── They come back with the project ───────────────────────────────────────
  const second = await launchApp()
  await waitForStartupReady(second.page)
  await stubOpenDialog(second.electronApp, [projectFile])
  await second.page.getByRole('button', { name: 'Open Project…' }).click()
  await expect(second.page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({
    timeout: 30_000
  })

  // ── And Clear All removes every one of them ───────────────────────────────
  // Enabled in a process that never placed a marker: the engine restored them
  // from the file rather than the renderer remembering them. Asserted and
  // invoked without closing the menu in between, because the menu is rebuilt on
  // every project-state change and a close/reopen cycle can race that rebuild.
  const clearItem = await openEditMenu(second.page)
  await expect(clearItem).toBeEnabled()
  await clearItem.click()

  await expectMarkersPresent(second.page, false)

  await invokeMenuItem(second.page, 'File', 'Save', { exact: true })
  await expect(second.page.getByLabel('Unsaved changes')).toBeHidden({ timeout: 30_000 })

  // Cleared in the document too, not merely hidden from the timeline.
  await expect
    .poll(() => savedMarkerPositions(projectFile)?.length ?? -1, {
      timeout: 30_000,
      message: `expected ${projectFile} to record no markers`
    })
    .toBe(0)
})
