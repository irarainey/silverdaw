// J6 — Reopening a project from the start screen's recent list.
//
// The recent list is the fastest route back into work, and it is the one open path
// that crosses persisted preferences: the MRU lives in `preferences.json`, so this
// covers main-process state surviving a launch as well as the load itself.
//
// The entry is seeded rather than earned by saving first. A spec that saved a
// project to populate the list would prove the save path far more than the recent
// path, and would fail for reasons that have nothing to do with what it names.

import { expect, test } from '../fixtures/silverdaw'
import { libraryItem, libraryItems } from '../helpers/library'
import {
  copyProjectFixture,
  FIXTURE_AUDIO_FILE,
  FIXTURE_MASTER_VOLUME,
  FIXTURE_PROJECT_NAME
} from '../helpers/projectFixtures'
import { recentProjectEntry, waitForStartupReady } from '../helpers/startup'

test('a project opens from the start screen recent list', async ({ launchApp }) => {
  const projectFile = copyProjectFixture()
  const app = await launchApp({
    recentProjects: [{ path: projectFile, name: FIXTURE_PROJECT_NAME }]
  })

  await waitForStartupReady(app.page)

  const recent = recentProjectEntry(app.page, projectFile)
  await expect(recent).toBeVisible()
  await recent.click()

  await expect(libraryItem(app.page, FIXTURE_AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(libraryItems(app.page)).toHaveCount(1)
  await expect(app.page.getByTitle(/^Master volume:/)).toHaveAttribute(
    'title',
    FIXTURE_MASTER_VOLUME
  )
})
