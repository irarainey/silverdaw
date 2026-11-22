import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from '../fixtures/silverdaw'
import { stubOpenDialog } from '../helpers/dialogs'
import { invokeMenuItem } from '../helpers/menu'
import { findNode, type ProjectNode } from '../helpers/projectDocument'
import { copyProjectFixture, FIXTURE_AUDIO_FILE } from '../helpers/projectFixtures'
import { waitForStartupReady } from '../helpers/startup'

test('legacy recording links reach the report as exact, window-only, or unknown', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  const projectFile = copyProjectFixture()
  const dir = dirname(projectFile)
  const doc = JSON.parse(readFileSync(projectFile, 'utf8')) as { project: ProjectNode }
  const library = findNode(doc.project, 'LIBRARY')
  if (!library?.$children || !doc.project.$children) throw new Error('Fixture library is missing')
  const placements = [
    { id: 'plain', itemId: 'l1', inMs: 200, name: 'Direct placement' },
    { id: 'baked', itemId: 'scratch', inMs: 100, name: 'Legacy scratch' },
    { id: 'orphan', itemId: 'orphan', inMs: 0, name: 'Unmapped stem' }
  ]
  for (const item of [
    { id: 'scratch', kind: 'sample', sourceItemId: 'l1', scratchPatternId: 'old-pattern', sourceInMs: 800, sourceDurationMs: 600 },
    { id: 'orphan', kind: 'stem', sourceItemId: 'unavailable' }
  ]) {
    const fileName = `${item.id}.wav`
    copyFileSync(join(dir, FIXTURE_AUDIO_FILE), join(dir, fileName))
    library.$children.push({ $type: 'ITEM', ...item, filePath: fileName, name: fileName, durationMs: 2000,
      sampleRate: 44100, channelCount: 2 })
  }
  for (const { id, itemId, inMs, name } of placements) {
    doc.project.$children.push({ $type: 'TRACK', id: `track-${id}`, name, gain: 1,
      $children: [{ $type: 'CLIP', id, libraryItemId: itemId, inMs, durationMs: 200, offsetMs: 0 }] })
  }
  writeFileSync(projectFile, JSON.stringify(doc))

  await waitForStartupReady(page)
  await stubOpenDialog(electronApp, [projectFile])
  await page.getByRole('button', { name: 'Open Project…' }).click()
  await expect(page.getByTitle(projectFile).first()).toBeVisible()
  await invokeMenuItem(page, 'File', 'Audio Sample Report')
  const report = page.getByRole('dialog', { name: 'Audio Sample Report', exact: true })
  const passage = (track: string) => report.getByRole('row').filter({ hasText: track }).getByRole('cell').last()
  await expect(passage('Direct placement')).toHaveText('0:00.200 – 0:00.400')
  await expect(passage('Legacy scratch')).toHaveText('Within 0:00.800 – 0:01.400 (source window only)')
  await expect(passage('Unmapped stem')).toHaveText('Cannot be determined')
})
