// J5 — Opening a project saved by an earlier release.
//
// The backward-compatibility canary. CONTEXT.md makes it CRITICAL that saved
// projects keep opening across updates, and Silverdaw ships auto-updating from the
// Microsoft Store, so a reader regression would reach users who never chose to take
// it. The fixture was written by 1.4.1 and is frozen; see helpers/projectFixtures.ts.
//
// The assertions target what a silent regression would quietly drop — the media
// reference and the stored mix — rather than merely that a window appeared.
//
// Note there is no assertion on the displayed project name. The fixture stores
// `name: "Untitled"` despite having been saved as "E2E Fixture": the 1.4.1 backend
// adopted the filename only *after* serialising and then marked the project clean,
// so the chosen name never reached disk. That is fixed as of 1.4.2 (see
// project-round-trip.e2e.ts, which asserts the name survives a save and restart),
// but the fix applies to new saves and does not rewrite existing files. The frozen
// fixture is a faithful 1.4.1 artefact and must not be regenerated, so asserting a
// name here would test the old defect rather than the compatibility guarantee.

import { expect, test } from '../fixtures/silverdaw'
import { stubOpenDialog } from '../helpers/dialogs'
import { libraryItem, libraryItems } from '../helpers/library'
import {
  copyProjectFixture,
  FIXTURE_AUDIO_FILE,
  FIXTURE_MASTER_VOLUME
} from '../helpers/projectFixtures'
import { waitForStartupReady } from '../helpers/startup'

test('a project saved by an earlier release still opens with its media and mix', async ({
  silverdaw
}) => {
  const projectFile = copyProjectFixture()

  await waitForStartupReady(silverdaw.page)
  await stubOpenDialog(silverdaw.electronApp, [projectFile])
  await silverdaw.page.getByRole('button', { name: 'Open Project…' }).click()

  // Resolving this proves the relative media path was rebased onto the project's
  // new location, which is what makes a saved project portable at all.
  await expect(libraryItem(silverdaw.page, FIXTURE_AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(libraryItems(silverdaw.page)).toHaveCount(1)

  await expect(silverdaw.page.getByTitle(/^Master volume:/)).toHaveAttribute(
    'title',
    FIXTURE_MASTER_VOLUME
  )
})
