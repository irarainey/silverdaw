/** Pre-flight writability guard for a user-chosen save/export destination. */
import { dialog, type BrowserWindow } from 'electron'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Verify `dir` exists and is writable by creating and deleting a probe file.
 * On failure — a read-only or protected location (e.g. a Program Files /
 * WindowsApps path, or a locked network share) — shows a clear error dialog and
 * returns `false` so the caller can abort the save/export gracefully instead of
 * surfacing a cryptic backend write error.
 */
export async function ensureWritableTargetDir(win: BrowserWindow, dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true })
    const probe = join(dir, `.silverdaw-write-test-${process.pid}-${Date.now()}`)
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return true
  } catch {
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Can\u2019t save here',
      message: 'Silverdaw can\u2019t write to the selected location.',
      detail: `The folder is read-only or protected:\n${dir}\n\nPlease choose a different location, such as your Documents or Music folder.`
    })
    return false
  }
}
