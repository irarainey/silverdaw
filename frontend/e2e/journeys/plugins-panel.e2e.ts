// J25 — Plugins panel: the tab exists, and its empty states tell the user what to do next.
//
// VST3 hosting is the one feature whose interesting behaviour cannot be asserted on an
// arbitrary machine: what a scan finds depends on what the user happens to have installed, and
// a journey that added a real plugin would pass or fail on the contents of `Common Files\VST3`
// rather than on Silverdaw. So this journey deliberately stops at the boundary that *is*
// deterministic — the panel opens, it survives a track selection, and each empty state says
// something actionable — and leaves chain behaviour to the backend's unit tests, where a fake
// plugin makes it exact.
//
// The no-track and no-plugins states are checked separately because they are produced by
// different branches and only one of them is reachable at a time: a fresh project has no track
// at all, and the moment one is added the message must change rather than simply disappear.

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { startNewProject } from '../helpers/startup'

test('the Plugins panel opens and explains both of its empty states', async ({ launchApp }) => {
  const app = await launchApp()
  const { page } = app

  await startNewProject(page)

  const pluginsTab = page.getByRole('button', { name: 'Plugins', exact: true })
  await expect(pluginsTab).toBeVisible()
  await pluginsTab.click()
  await expect(pluginsTab).toHaveAttribute('aria-pressed', 'true')

  const panel = page.getByLabel('Plugins', { exact: true })
  await expect(panel).toBeVisible()

  // Nothing is selected yet, so the panel asks for a track rather than showing an empty rack.
  await expect(panel.getByText('Select a track to add plugins to it.')).toBeVisible()

  // The chooser is present but inert with no plugin chosen, so a stray click cannot add one.
  await expect(panel.getByRole('button', { name: 'Add Plugin' })).toBeDisabled()
  await expect(panel.getByRole('button', { name: 'Scan Plugins' })).toBeEnabled()

  // Adding a track selects it, which moves the panel on to its second empty state.
  await page.getByRole('button', { name: 'Add Track' }).click()
  await expect(
    panel.getByText('No plugins on this track yet. Choose one above and select Add Plugin.')
  ).toBeVisible({ timeout: 30_000 })
  await expect(panel.getByText('Select a track to add plugins to it.')).toBeHidden()

  // The panel is a peer of the other lower-panel tabs, not a replacement for them.
  const trackFxTab = page.getByRole('button', { name: 'Track FX', exact: true })
  await trackFxTab.click()
  await expect(trackFxTab).toHaveAttribute('aria-pressed', 'true')
  await expect(pluginsTab).toHaveAttribute('aria-pressed', 'false')
  await expect(panel).toBeHidden()

  await closeSilverdaw(app)
})
