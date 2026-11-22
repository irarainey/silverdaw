import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BaseWindow, SaveDialogOptions } from 'electron'
import type { ElectronApplication } from '@playwright/test'
import { expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { invokeMenuItem } from '../helpers/menu'
import { findNode, type ProjectNode } from '../helpers/projectDocument'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

async function acceptSuggestedPdf(app: ElectronApplication, projectPath = ''): Promise<void> {
  await app.evaluate(({ dialog }, project) => {
    dialog.showSaveDialog = async (...args: [SaveDialogOptions] | [BaseWindow, SaveDialogOptions]) => {
      const options = args.length === 2 ? args[1] : args[0]
      const filePath = options.title === 'Save Silverdaw Project' ? project : options.defaultPath
      return { canceled: !filePath, filePath: filePath ?? '' }
    }
  }, projectPath)
}

test('Audio Sample Report previews a placed file and saves the report as PDF', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  await startNewProject(page)
  await invokeMenuItem(page, 'File', 'Audio Sample Report')
  const report = page.getByRole('dialog', { name: 'Audio Sample Report', exact: true })
  await expect(report).toContainText('No clips are placed')
  const card = report.locator('.dialog-card')
  const emptyHeight = await card.evaluate(el => el.clientHeight)
  await page.keyboard.press('Escape')
  await expect(report).toBeHidden()

  const path = createToneWav({ fileName: 'sample-report.wav', seconds: 2 })
  await page.getByRole('button', { name: 'Add Track' }).click()
  await stubOpenDialog(electronApp, [path])
  await page.getByTitle('Import audio file...').click()
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })
  await invokeMenuItem(page, 'File', 'Audio Sample Report')
  await expect(report).toContainText(path)
  expect(await card.evaluate(el => el.clientHeight)).toBe(emptyHeight)
  await expect(report.getByRole('heading', { name: 'Track: sample-report.wav' })).toBeVisible()
  await expect(report.getByText('Artist: Cannot be determined', { exact: true })).toBeVisible()
  await expect(report.getByText('Album: Cannot be determined', { exact: true })).toBeVisible()
  await expect(report.getByText('File metadata', { exact: true })).toHaveCount(0)
  await expect(report.getByRole('cell', { name: 'Source', exact: true })).toBeVisible()
  await expect(report.getByRole('columnheader', { name: 'Original recording range' })).toBeVisible()
  await expect(report).toContainText('Known distinct passages: 1')
  await expect(report.getByRole('cell', { name: '0:00.000 – 0:02.000', exact: true }).last()).toBeVisible()

  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('#app')).toBeHidden()
  await expect(report.getByText(`Source file: ${path}`)).toBeVisible()
  await expect(report.getByRole('button', { name: 'Save and Export PDF', exact: true })).toBeHidden()
  await page.emulateMedia({ media: 'screen' })

  const root = makeTrackedTempDir('report')
  const audit = join(root, 'Attribution', 'audit')
  const files = () => existsSync(audit) ? readdirSync(audit) : []
  await acceptSuggestedPdf(electronApp, join(root, 'Attribution.silverdaw'))
  await report.getByRole('button', { name: 'Save and Export PDF', exact: true }).click()
  await expect.poll(files).toHaveLength(1)
  await expect(report).toBeHidden()
  await invokeMenuItem(page, 'File', 'Audio Sample Report')
  await expect(report.getByRole('heading', { name: 'Project name: Attribution' })).toBeVisible()
  await expect(report.getByText(`Location: ${join(root, 'Attribution')}`, { exact: true })).toBeVisible()
  const exportPdf = report.getByRole('button', { name: 'Export PDF', exact: true })
  const other = makeTrackedTempDir('other-report-folder')
  await stubSaveDialog(electronApp, join(other, 'Custom.pdf'))
  await exportPdf.click()
  await expect.poll(() => existsSync(join(other, 'Custom.pdf'))).toBe(true)
  await expect(report).toBeHidden()
  // Main can prepare valid JSON that the backend subsequently rejects.
  const invalidProject = join(root, 'Rejected.silverdaw')
  writeFileSync(invalidProject, '{}')
  await stubOpenDialog(electronApp, [invalidProject])
  await invokeMenuItem(page, 'File', 'Open Project')
  await expect(page.getByText(/Could not open project:/)).toBeVisible()
  await invokeMenuItem(page, 'File', 'Audio Sample Report')
  await stubSaveDialog(electronApp, null)
  await exportPdf.click()
  await expect(exportPdf).toBeEnabled()
  await acceptSuggestedPdf(electronApp)
  await exportPdf.click()
  await expect.poll(() => readdirSync(other)).toHaveLength(2)
  expect(files()).toHaveLength(1)
  for (const name of files()) {
    expect(name).toMatch(/^Audio Sample Report \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.pdf$/)
    const pdf = readFileSync(join(audit, name)).toString('latin1')
    expect(pdf.startsWith('%PDF-')).toBe(true)
    const pages = [...pdf.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
    expect(pages.length).toBeGreaterThan(0)
    for (const [, width, height] of pages) expect(Number(width)).toBeGreaterThan(Number(height))
  }

  const first = join(root, 'Attribution', 'Attribution.silverdaw')
  const secondRoot = makeTrackedTempDir('second-project')
  const second = join(secondRoot, 'Second.silverdaw')
  // A standalone derived file can survive without its original in this project.
  const document = JSON.parse(readFileSync(first, 'utf8')) as { project: ProjectNode }
  const item = findNode(document.project, 'ITEM')
  if (!item) throw new Error('Saved project did not contain the imported file')
  item.kind = 'sample'
  item.attribution = {
    recordingId: 'missing-recording', fileName: 'Original.mp3', artist: 'Recording artist',
    isrc: 'GBABC2600001', composer: 'A. Writer', label: 'Example label', copyright: 'Example notice',
    startMs: 10300, endMs: 14450
  }
  writeFileSync(second, JSON.stringify(document))
  for (const [projectFile, folder, count] of [
    [second, join(secondRoot, 'audit'), 1], [first, audit, 2]
  ] as const) {
    await expect(report).toBeHidden()
    await stubOpenDialog(electronApp, [projectFile])
    await invokeMenuItem(page, 'File', 'Open Project')
    await expect(page.getByTitle(projectFile).first()).toBeVisible()
    await invokeMenuItem(page, 'File', 'Audio Sample Report')
    if (projectFile === second) {
      await expect(report).toContainText('Source file: Original.mp3')
      await expect(report).toContainText('Artist: Recording artist')
      const window = report.getByRole('cell', { name: 'Within 0:10.300 – 0:14.450 (source window only)' })
      await expect(window).toBeVisible()
      await expect(report.getByText('ISRC: GBABC2600001')).toBeVisible()
      await expect(report.getByText('Composer: A. Writer')).toBeVisible()
      await expect(report.getByText('Label: Example label')).toBeVisible()
      await page.emulateMedia({ media: 'print' })
      await expect(report.getByText('Copyright notice: Example notice')).toBeVisible()
      await expect(window).toBeVisible()
      await page.emulateMedia({ media: 'screen' })
    }
    await exportPdf.click()
    await expect.poll(() => existsSync(folder) ? readdirSync(folder).length : 0).toBe(count)
  }
})
