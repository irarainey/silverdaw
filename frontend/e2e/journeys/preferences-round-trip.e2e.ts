// J12 — A legacy preferences file is read on launch and rewritten in the current shape.
//
// Every upgrade lands on a `preferences.json` written by an older build, so the
// loader has to tolerate a document that is missing keys and carries values the
// current build would never write. `PrefsService.load` handles that by rebuilding
// an exhaustive object over `buildDefaultPrefs()` (main/prefsService.ts), which
// means an upgrade both fills gaps and drops anything it no longer recognises.
//
// The merge and clamping rules are pure functions and are already covered far more
// cheaply in tests/main/preferences.test.ts. What only an end-to-end run can show
// is that the real file on disk is actually read at startup, surfaces in the UI,
// and is written back in the current shape when the user saves — the round trip
// across the main process, the renderer, and the filesystem.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '../fixtures/silverdaw'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject, waitForStartupReady } from '../helpers/startup'

/**
 * Well outside the accepted 5..600 range, so the value the dialog shows can only
 * have come from the loader clamping what was on disk.
 */
const OUT_OF_RANGE_INTERVAL = 99_999
const CLAMPED_INTERVAL = 600
const CHOSEN_INTERVAL = 45

interface PreferencesDocument {
  autosave?: { enabled?: boolean; intervalSeconds?: number }
  ui?: Record<string, unknown>
  stems?: Record<string, unknown>
  legacyKeyFromAnOlderBuild?: unknown
}

function readPreferences(userDataDir: string): PreferencesDocument {
  return JSON.parse(
    readFileSync(join(userDataDir, 'preferences.json'), 'utf8')
  ) as PreferencesDocument
}

test('a legacy preferences file survives launch and is rewritten in the current shape', async ({
  launchApp
}) => {
  const app = await launchApp({
    preferences: {
      autosave: { enabled: true, intervalSeconds: OUT_OF_RANGE_INTERVAL },
      legacyKeyFromAnOlderBuild: 'no longer read by any current code path'
    }
  })

  await waitForStartupReady(app.page)
  await startNewProject(app.page)

  await invokeMenuItem(app.page, 'Edit', 'Preferences')
  const dialog = app.page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('tab', { name: 'Project' }).click()

  // Proves the seeded file reached the renderer: the default is 30, so 600 can
  // only be the out-of-range value from disk after the loader clamped it.
  const interval = dialog.locator('#autosave-interval')
  await expect(interval).toHaveValue(String(CLAMPED_INTERVAL))

  await interval.fill(String(CHOSEN_INTERVAL))
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  await expect
    .poll(() => {
      // `expect.poll` propagates a throw instead of retrying, so a read that
      // lands mid-write has to degrade to "not there yet" rather than fail.
      try {
        return readPreferences(app.userDataDir).autosave?.intervalSeconds
      } catch {
        return undefined
      }
    })
    .toBe(CHOSEN_INTERVAL)

  const saved = readPreferences(app.userDataDir)

  // Keys absent from the seeded document are now present: the rewrite emits the
  // current full shape rather than patching what happened to be there before.
  expect(saved.ui).toBeDefined()
  expect(saved.stems).toBeDefined()
  expect(saved.autosave?.enabled).toBe(true)

  // The other half of that contract, and the reason an upgrade cannot accumulate
  // rubbish: a key the current build does not know about is not carried forward.
  expect(saved.legacyKeyFromAnOlderBuild).toBeUndefined()
})


