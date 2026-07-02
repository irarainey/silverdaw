// Mixdown export IPC handlers: resolve a default output path, native save-as
// dialog, and an overwrite prompt for manually typed paths. Registered from
// main/index.ts.

import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { IPC } from '../../shared/ipc-channels'
import { ensureWritableTargetDir } from '../writableTarget'
import type { PrefsService } from '../prefsService'

export interface MixdownHandlersContext {
  getMainWindow(): BrowserWindow | null
  prefs: PrefsService
}

function extensionForFormat(format: unknown): 'mp3' | 'flac' | 'aiff' | 'wav' {
  return format === 'mp3' ? 'mp3' : format === 'flac' ? 'flac' : format === 'aiff' ? 'aiff' : 'wav'
}

export function registerMixdownHandlers(ctx: MixdownHandlersContext): void {
  const { prefs } = ctx

  // Default mixdowns under `mixdown/`; backend creates the folder only when writing.
  ipcMain.handle(
    IPC.mixdown.resolveDefaultPath,
    async (
      _evt,
      projectFilePath: unknown,
      projectName: unknown,
      format: unknown
    ): Promise<string> => {
      const safeName =
        (typeof projectName === 'string' && projectName.trim().length > 0
          ? projectName.trim()
          : 'Untitled')
          // Make the suggested filename valid on Windows.
          .replace(/[\\/:*?"<>|]/g, '_')
      const ext = extensionForFormat(format)
      const baseDir =
        typeof projectFilePath === 'string' && projectFilePath.length > 0
          ? dirname(projectFilePath)
          : prefs.get().paths.defaultProjectDir || tmpdir()
      return join(baseDir, 'mixdown', `${safeName}.${ext}`)
    }
  )

  ipcMain.handle(
    IPC.mixdown.chooseSaveAs,
    async (_evt, defaultPath: unknown, format: unknown): Promise<string | null> => {
      const win = ctx.getMainWindow()
      if (!win) return null
      const suggestedDefaultPath =
        typeof defaultPath === 'string' && defaultPath.length > 0
          ? defaultPath
          : join(prefs.get().paths.defaultProjectDir || tmpdir(), 'mixdown', 'Mixdown.wav')
      const ext = extensionForFormat(format)
      const filters =
        ext === 'mp3'
          ? [{ name: 'MP3 audio', extensions: ['mp3'] }]
          : ext === 'flac'
            ? [{ name: 'FLAC audio', extensions: ['flac'] }]
            : ext === 'aiff'
              ? [{ name: 'AIFF audio', extensions: ['aiff', 'aif'] }]
              : [{ name: 'WAV audio', extensions: ['wav'] }]
      try {
        await mkdir(dirname(suggestedDefaultPath), { recursive: true })
      } catch {
        // Best-effort: missing volume falls back to the dialog's last cwd.
      }
      const result = await dialog.showSaveDialog(win, {
        title: 'Export Mixdown',
        defaultPath: suggestedDefaultPath,
        filters
      })
      if (result.canceled || !result.filePath) return null
      if (!(await ensureWritableTargetDir(win, dirname(result.filePath)))) return null
      return result.filePath
    }
  )

  // Extra overwrite prompt for manually typed mixdown paths.
  ipcMain.handle(
    IPC.mixdown.confirmOverwrite,
    async (_evt, filePath: unknown): Promise<'overwrite' | 'cancel' | 'not-found'> => {
      if (typeof filePath !== 'string' || filePath.length === 0) return 'not-found'
      if (!existsSync(filePath)) return 'not-found'
      const win = ctx.getMainWindow()
      if (!win) return 'cancel'
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Overwrite', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Replace existing file?',
        message: `"${basename(filePath)}" already exists.`,
        detail: 'Choose Overwrite to replace it, or Cancel to edit the filename.'
      })
      return result.response === 0 ? 'overwrite' : 'cancel'
    }
  )
}
