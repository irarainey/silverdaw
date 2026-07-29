// J13 — Undo and redo, persisted across a restart.
//
// Undo is not renderer state. The backend owns the `UndoManager`, and the Edit
// menu's Undo / Redo items grey out from `EDIT_UNDO_STATE` pushed over the
// bridge (see `useAppTitleBarController`). So this journey is only meaningful
// with a real engine attached: it proves the engine registered a transaction,
// reported its availability, reverted it on request, and reinstated it on redo.
//
// The save and cold reopen at the end matter for the same reason J3's do. An
// undo that only repainted the renderer would pass every in-memory check and
// still lose the user's work the moment they saved — the guarantee is that the
// state left behind by a redo is the state that reaches disk.
//
// Adding a track is used as the edit under test because it is exactly one
// transaction. Importing audio registers two — the import itself, then the
// automatic grid alignment that follows analysis — so a journey built on it
// would be asserting that pairing rather than undo/redo itself.
//
// Track count is read from the per-track import button, which exists once per
// empty track. That keeps the assertion on DOM the user can see rather than on
// canvas pixels.

import { type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { closeMenu, invokeMenuItem, menuItem, openMenu } from '../helpers/menu'
import { startNewProject, waitForStartupReady } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

const PROJECT_NAME = 'E2E Undo Redo'
const EMPTY_TRACK = 'Import audio file...'

/** Empty tracks each render their own import button, so this counts tracks. */
const emptyTracks = (page: Page): Locator => page.getByTitle(EMPTY_TRACK)

/**
 * Asserts an Edit-menu item's availability and then invokes it without closing
 * and reopening the menu in between. The menu is rebuilt whenever project state
 * changes, so a close/reopen cycle can race that rebuild.
 */
const assertAndInvoke = async (page: Page, item: 'Undo' | 'Redo'): Promise<void> => {
  await openMenu(page, 'Edit')
  const target = menuItem(page, item)
  await expect(target).toBeEnabled()
  await target.click()
}

test('an edit can be undone, redone, and survives a restart', async ({ launchApp }) => {
  const projectsDir = makeTrackedTempDir('projects')
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)

  const first = await launchApp()
  const { page } = first
  await startNewProject(page)

  // Nothing has been edited yet, so the engine must report an empty stack.
  // Asserting this first is what gives the later "enabled" assertions meaning.
  await openMenu(page, 'Edit')
  await expect(menuItem(page, 'Undo')).toBeDisabled()
  await expect(menuItem(page, 'Redo')).toBeDisabled()
  await closeMenu(page)

  await page.getByRole('button', { name: 'Add Track' }).click()
  await expect(emptyTracks(page)).toHaveCount(1)
  await page.getByRole('button', { name: 'Add Track' }).click()
  await expect(emptyTracks(page)).toHaveCount(2)

  // ── Undo ──────────────────────────────────────────────────────────────────
  await assertAndInvoke(page, 'Undo')
  await expect(emptyTracks(page)).toHaveCount(1, { timeout: 30_000 })

  // ── Redo ──────────────────────────────────────────────────────────────────
  await assertAndInvoke(page, 'Redo')
  await expect(emptyTracks(page)).toHaveCount(2, { timeout: 30_000 })

  // ── The redone state is what reaches disk ─────────────────────────────────
  await stubSaveDialog(first.electronApp, chosenPath)
  await invokeMenuItem(page, 'File', 'Save As')
  await expect(page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()
  await closeSilverdaw(first)

  const second = await launchApp()
  await waitForStartupReady(second.page)
  await stubOpenDialog(second.electronApp, [projectFile])
  await second.page.getByRole('button', { name: 'Open Project…' }).click()

  await expect(emptyTracks(second.page)).toHaveCount(2, { timeout: 30_000 })

  // A freshly loaded project has no history behind it, so the engine must not
  // offer to undo edits made in a previous session.
  await openMenu(second.page, 'Edit')
  await expect(menuItem(second.page, 'Undo')).toBeDisabled()
  await closeMenu(second.page)
})


