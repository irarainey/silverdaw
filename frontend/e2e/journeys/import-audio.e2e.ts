// J2 — Import audio into the library.
//
// The first journey that crosses every layer for real: a file on disk is read
// by main, decoded in the renderer, registered as a library item, and handed to
// the JUCE engine for peak generation and analysis. Unit tests can cover each
// hop in isolation but cannot prove they compose, which is exactly what this
// asserts.

import { expect, test } from '../fixtures/silverdaw'
import { stubOpenDialog } from '../helpers/dialogs'
import { createToneWav } from '../helpers/audioFixtures'
import { libraryItem, libraryItems } from '../helpers/library'
import { startNewProject } from '../helpers/startup'

test('an imported file appears as a library item', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  const wavPath = createToneWav({ fileName: 'e2e-tone.wav', seconds: 2 })

  await startNewProject(page)
  await expect(libraryItems(page)).toHaveCount(0)

  await stubOpenDialog(electronApp, [wavPath])
  // The empty-library placeholder offers its own "Import" link, so this targets
  // the panel-header button by its tooltip rather than by label alone.
  await page
    .getByRole('button', { name: 'Import', description: 'Import audio files into the library' })
    .click()

  // Analysis (peaks, BPM, key) runs in the engine after the item registers, so
  // allow for the round trip rather than assuming an instant appearance.
  await expect(libraryItem(page, 'e2e-tone.wav')).toBeVisible({ timeout: 30_000 })
  await expect(libraryItems(page)).toHaveCount(1)
})
