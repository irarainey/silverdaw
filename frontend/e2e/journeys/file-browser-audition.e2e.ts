// J24 — Browse, select and audition a file that was never imported.
//
// The Files tab is the one surface that plays audio the project knows nothing
// about: a folder on disk is crawled by main, listed in the renderer, and
// auditioned through the shared preview voice. The store's rules are unit
// tested, but what a user can actually *hit* is not — a row is a strip of
// columns, and the click target being only the title text is invisible to every
// tier below this one. The now-playing bar has the same property: it is a piece
// of DOM whose whole purpose is to stay reachable when the tree cannot be.
//
// So this asserts the interaction, not the arithmetic: a click far from the
// title selects the row, a double-click there plays it, the bar appears while it
// sounds without shifting the tree beneath it, and stopping it takes the bar
// away again while the file stays listed.

import { dirname } from 'node:path'

import { expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog } from '../helpers/dialogs'
import { startNewProject } from '../helpers/startup'

/** The now-playing bar's badge — the only text unique to it. */
const NOW_PLAYING_BADGE = 'Playing'

/** What the bar shows in place of a row when no audition is sounding. */
const IDLE_LABEL = 'Nothing playing'

test('a browsed file is selectable, auditionable, and leaves no stale now-playing bar', async ({
  silverdaw
}) => {
  const { page, electronApp } = silverdaw
  const wavPath = createToneWav({ fileName: 'browse-tone.wav', seconds: 2 })

  await startNewProject(page)
  await page.getByRole('button', { name: 'Files' }).click()

  // Folders only enter the browser through the native picker, so it is stubbed
  // the same way an import is.
  await stubOpenDialog(electronApp, [dirname(wavPath)])
  await page.getByRole('button', { name: 'Add a folder to the file browser' }).click()

  const rootRow = page.getByRole('treeitem').first()
  await expect(rootRow).toBeVisible({ timeout: 30_000 })
  if ((await rootRow.getAttribute('aria-expanded')) !== 'true') await rootRow.click()

  // Crawling a folder is asynchronous, so the row arrives after the click.
  const fileRow = page.getByRole('treeitem').filter({ hasText: 'browse-tone' })
  await expect(fileRow).toHaveCount(1, { timeout: 30_000 })
  await expect(fileRow).not.toHaveAttribute('data-selected', 'true')

  // The Type column, far from the title: the whole row is the target, not the name.
  const farFromTheTitle = fileRow.getByText('WAV', { exact: true })
  await farFromTheTitle.click()
  await expect(fileRow).toHaveAttribute('data-selected', 'true')

  await expect(page.getByText(NOW_PLAYING_BADGE, { exact: true })).toBeHidden()
  await expect(page.getByText(IDLE_LABEL, { exact: true })).toBeVisible()

  // The strip above the tree keeps its height whether or not anything is playing,
  // so the folders below must not move as an audition starts and stops.
  const tree = page.getByRole('tree')
  const treeTop = async (): Promise<number> => (await tree.boundingBox())!.y
  const topBeforePlaying = await treeTop()

  await farFromTheTitle.dblclick()

  // The bar is the handle on playback that scrolling and filtering cannot take away.
  await expect(page.getByText(NOW_PLAYING_BADGE, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(IDLE_LABEL, { exact: true })).toBeHidden()
  expect(await treeTop()).toBe(topBeforePlaying)

  await fileRow.getByRole('button', { name: 'Pause' }).click()

  // Stopped, it is an ordinary file again: no bar, still listed where it lives.
  await expect(page.getByText(NOW_PLAYING_BADGE, { exact: true })).toBeHidden()
  await expect(page.getByText(IDLE_LABEL, { exact: true })).toBeVisible()
  await expect(fileRow).toHaveCount(1)
  expect(await treeTop()).toBe(topBeforePlaying)
})
