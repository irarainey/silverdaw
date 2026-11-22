import { join } from 'node:path'
import { expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { invokeMenuItem } from '../helpers/menu'
import { findNode, readProjectDocument } from '../helpers/projectDocument'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'
import { openClipEditorOnFirstTrack } from '../helpers/timeline'

test('two clip volume handles at the same time survive Save', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  const name = 'volume-step.wav'
  const source = createToneWav({ fileName: name, channels: 1, seconds: 4, amplitude: 0 })
  await startNewProject(page)
  await page.getByRole('button', { name: 'Add Track' }).click()
  await stubOpenDialog(electronApp, [source])
  await page.getByTitle('Import audio file...').click()
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled()
  await openClipEditorOnFirstTrack(page, 10)
  const editor = page.getByRole('dialog', { name })
  await editor.getByRole('button', { name: 'Volume', exact: true }).click()
  const canvas = editor.locator('canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Missing clip waveform')
  const x = Math.round(box.width / 3)
  for (const fraction of [0.25, 0.75]) {
    await canvas.click({ position: { x, y: Math.round(18 + (box.height - 18) * fraction) } })
  }
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toBeHidden()
  const directory = makeTrackedTempDir('volume-step')
  await stubSaveDialog(electronApp, join(directory, 'Steps.silverdaw'))
  await invokeMenuItem(page, 'File', 'Save As')
  await expect.poll(() => {
    const project = readProjectDocument(join(directory, 'Steps', 'Steps.silverdaw'))
    const points = project && findNode(project, 'CLIP')?.envelopePoints
    if (!Array.isArray(points) || points.length !== 4) return false
    return points[1].timeMs === points[2].timeMs && points[1].gain !== points[2].gain
  }).toBe(true)
})
