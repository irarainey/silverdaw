import { join } from 'node:path'
import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { findNodes, readProjectDocument } from '../helpers/projectDocument'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'
import { openClipEditorOnFirstTrack } from '../helpers/timeline'

test('timeline context recovery preserves the live clip editor and saved clip', async ({ launchApp }) => {
  const fileName = 'renderer-recovery.wav'
  const wav = createToneWav({ fileName, seconds: 2, amplitude: 0 })
  const app = await launchApp()
  const { page } = app
  const rendererErrors: string[] = []
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await startNewProject(page)
  await page.getByRole('button', { name: 'Add Track' }).click()
  await stubOpenDialog(app.electronApp, [wav])
  await page.getByTitle('Import audio file...').click()
  await expect(libraryItem(page, fileName)).toBeVisible()
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled()
  await openClipEditorOnFirstTrack(page, 10)
  const dialog = page.getByRole('dialog', { name: fileName })
  await expect(dialog).toBeVisible()
  await expect(page.locator('canvas')).toHaveCount(2)

  await page.locator('canvas').first().evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Timeline canvas is missing')
    element.dataset['recoveryOriginal'] = 'true'
    const gl = element.getContext('webgl2') ?? element.getContext('webgl')
    const extension = gl?.getExtension('WEBGL_lose_context')
    if (!extension) throw new Error('WebGL context-loss extension is unavailable')
    extension.loseContext()
  })
  await expect(page.locator('canvas[data-recovery-original]')).toHaveCount(0)
  await expect(page.locator('canvas')).toHaveCount(2)
  await expect(dialog).toBeVisible()
  await expect.poll(() => page.locator('canvas').evaluateAll((canvases) =>
    canvases.every((element) => {
      if (!(element instanceof HTMLCanvasElement)) return false
      const gl = element.getContext('webgl2') ?? element.getContext('webgl')
      return !!gl && !gl.isContextLost()
    })
  )).toBe(true)
  await dialog.getByTitle('Zoom in (+)', { exact: true }).click()
  await expect(dialog.getByTitle('Reset zoom (0)', { exact: true })).not.toHaveText('100%')

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('canvas')).toHaveCount(1)
  await page.locator('canvas').hover()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -30)
  await page.keyboard.up('Control')
  await page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  })

  const directory = makeTrackedTempDir('renderer-recovery')
  const projectName = 'Renderer Recovery'
  const projectFile = join(directory, projectName, `${projectName}.silverdaw`)
  await stubSaveDialog(app.electronApp, join(directory, `${projectName}.silverdaw`))
  await invokeMenuItem(page, 'File', 'Save As')
  await expect.poll(() => {
    const saved = readProjectDocument(projectFile)
    return saved ? findNodes(saved, 'CLIP').length : 0
  }).toBe(1)
  await expect(page.getByLabel('Unsaved changes')).toBeHidden()
  expect(rendererErrors).toEqual([])
  await closeSilverdaw(app)
})
