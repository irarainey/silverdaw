// Project file lifecycle IPC handlers: native open/save dialogs, existence check,
// the Recent Projects MRU, project pre-open path allow-listing, and consuming a
// pending launch path. Registered from main/index.ts.

import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import { registerIssuedPath } from '../audioPaths'
import type { PrefsService } from '../prefsService'

export interface ProjectHandlersContext {
  getMainWindow(): BrowserWindow | null
  prefs: PrefsService
  consumePendingOpenPath(): string | null
}

export function registerProjectHandlers(ctx: ProjectHandlersContext): void {
  const { prefs } = ctx

  // ─── Project file lifecycle ─────────────────────────────────────────────
  // Main owns native project dialogs and the Recent Projects MRU.

  ipcMain.on(IPC.project.setLastPath, (_evt, value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return
    if (prefs.bumpRecentProject(value)) prefs.flushSaveSync()
  })

  ipcMain.handle(IPC.project.fileExists, async (_evt, value: unknown): Promise<boolean> => {
    if (typeof value !== 'string' || value.length === 0) return false
    try {
      await readFile(value, { encoding: null, flag: 'r' })
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.project.chooseOpen, async (): Promise<string | null> => {
    const win = ctx.getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Open Silverdaw Project',
      defaultPath: prefs.get().paths.defaultProjectDir || undefined,
      filters: [{ name: 'Silverdaw project', extensions: ['silverdaw'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    IPC.project.chooseSaveAs,
    async (_evt, defaultName: unknown): Promise<string | null> => {
      const win = ctx.getMainWindow()
      if (!win) return null
      const suggested =
        typeof defaultName === 'string' && defaultName.length > 0 ? defaultName : 'Untitled'
      const defaultProjectDir = prefs.get().paths.defaultProjectDir
      const defaultPath = defaultProjectDir
        ? join(defaultProjectDir, `${suggested}.silverdaw`)
        : `${suggested}.silverdaw`
      const result = await dialog.showSaveDialog(win, {
        title: 'Save Silverdaw Project',
        defaultPath,
        filters: [{ name: 'Silverdaw project', extensions: ['silverdaw'] }]
      })
      if (result.canceled || !result.filePath) return null
      return result.filePath
    }
  )

  // Pre-register project audio paths; `registerIssuedPath` still enforces the allow-list.
  ipcMain.handle(IPC.project.prepareOpen, async (_evt, filePath: unknown): Promise<boolean> => {
    if (typeof filePath !== 'string' || filePath.length === 0) return false
    if (extname(filePath).toLowerCase() !== '.silverdaw') return false
    try {
      const content = await readFile(filePath, 'utf8')
      // Project JSON may contain `filePath` anywhere in the tree.
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (parseErr) {
        console.warn('[project:prepareOpen] malformed project JSON:', filePath, parseErr)
        return false
      }
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) visit(item)
          return
        }
        if (node !== null && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            if (k === 'filePath' && typeof v === 'string' && v.length > 0) {
              registerIssuedPath(v)
            } else {
              visit(v)
            }
          }
        }
      }
      visit(parsed)
      return true
    } catch (err) {
      console.warn('[project:prepareOpen] could not read project file:', filePath, err)
      return false
    }
  })

  // Consume a pending launch path once so renderer reloads do not reopen it.
  ipcMain.handle(IPC.project.consumePendingOpenPath, (): string | null => ctx.consumePendingOpenPath())

  // ─── Recent projects (MRU) ─────────────────────────────────────────────
  ipcMain.handle(IPC.prefs.getRecentProjects, (): string[] => [...prefs.get().recentProjects])

  ipcMain.on(IPC.prefs.removeRecentProject, (_evt, value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return
    const key = value.toLowerCase()
    const store = prefs.get()
    const before = store.recentProjects.length
    store.recentProjects = store.recentProjects.filter((p) => p.toLowerCase() !== key)
    if (store.recentProjects.length !== before) prefs.flushSaveSync()
  })

  ipcMain.on(IPC.prefs.clearRecentProjects, () => {
    const store = prefs.get()
    if (store.recentProjects.length === 0) return
    store.recentProjects = []
    prefs.flushSaveSync()
  })
}
