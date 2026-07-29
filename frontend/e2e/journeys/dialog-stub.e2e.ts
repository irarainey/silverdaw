// Proves the native-dialog seam that every later journey depends on.
//
// Import, open, save, and export all funnel through OS-owned dialogs that
// Playwright cannot click. If the stubbing approach did not work, those
// journeys would hang rather than fail, so this is verified once, explicitly,
// rather than being assumed by each journey that relies on it.

import { expect, test } from '../fixtures/silverdaw'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'

test('stubbed dialogs resolve in the main process without user input', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw

  await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible({ timeout: 60_000 })

  await stubOpenDialog(electronApp, ['C:\\fixtures\\tone.wav'])
  const opened = await electronApp.evaluate(({ dialog, BrowserWindow }) =>
    dialog.showOpenDialog(BrowserWindow.getAllWindows()[0]!, { properties: ['openFile'] })
  )
  expect(opened).toEqual({ canceled: false, filePaths: ['C:\\fixtures\\tone.wav'] })

  await stubSaveDialog(electronApp, 'C:\\fixtures\\mix.silverdaw')
  const saved = await electronApp.evaluate(({ dialog, BrowserWindow }) =>
    dialog.showSaveDialog(BrowserWindow.getAllWindows()[0]!, {})
  )
  expect(saved.canceled).toBe(false)
  expect(saved.filePath).toBe('C:\\fixtures\\mix.silverdaw')
})

test('cancelling the open dialog leaves the startup screen interactive', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw

  const newProject = page.getByRole('button', { name: 'New Project' })
  await expect(newProject).toBeVisible({ timeout: 60_000 })

  // An unstubbed dialog here would open a real modal OS window and stall the run.
  await stubOpenDialog(electronApp, [])
  await page.getByRole('button', { name: 'Open Project…' }).click()

  await expect(newProject).toBeEnabled()
})
