// Project file lifecycle IPC handlers: native open/save dialogs, existence check,
// the Recent Projects MRU, project pre-open path allow-listing, and consuming a
// pending launch path. Registered from main/index.ts.

import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { readFile, mkdir, cp } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import { registerIssuedPath, registerStemsWriteRoot, registerSamplesWriteRoot, registerProjectMediaRoots, getProjectMediaDirs } from '../audioPaths'
import { canonicaliseProjectPath, projectFolderPath } from '../projectPaths'
import type { PrefsService } from '../prefsService'
import { logMain } from '../log'

export interface ProjectHandlersContext {
  getMainWindow(): BrowserWindow | null
  prefs: PrefsService
  consumePendingOpenPath(): string | null
}

// Copy every file in the central media store's source folder into the destination
// (used to carry cover art + tags from the temp workspace / previous project folder
// into the project folder on save). A missing source means no media yet — that's fine.
async function copyDirContents(src: string, dest: string): Promise<void> {
  try {
    await mkdir(dest, { recursive: true })
    await cp(src, dest, { recursive: true, force: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      logMain('WARN ', 'project:saveMedia', `media copy ${src} -> ${dest} failed:`, err)
    }
  }
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
    const canonical = canonicaliseProjectPath(value)
    if (canonical === null) return false
    try {
      await readFile(canonical, { encoding: null, flag: 'r' })
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
      const target = projectFolderPath(result.filePath)
      await mkdir(dirname(target), { recursive: true })
      // The backend writes this project's stems beside the file; trust that folder
      // for renderer reads + sidecar writes ahead of the first separation.
      registerStemsWriteRoot(join(dirname(target), 'Stems'))
      // Likewise the project's Samples folder, where music samples persist their
      // inherited metadata/cover sidecar.
      registerSamplesWriteRoot(join(dirname(target), 'Samples'))
      // Carry the central media store (cover art + tags) into the project folder so it
      // survives the save: items imported while the project was unsaved wrote it to the
      // temp workspace, and a "Save As" copies it from the previous project folder.
      const previousMedia = getProjectMediaDirs()
      registerProjectMediaRoots(dirname(target))
      const nextMedia = getProjectMediaDirs()
      if (previousMedia && nextMedia && previousMedia.metadataDir !== nextMedia.metadataDir) {
        await copyDirContents(previousMedia.metadataDir, nextMedia.metadataDir)
        await copyDirContents(previousMedia.coversDir, nextMedia.coversDir)
      }
      return target
    }
  )

  // Pre-register project audio paths; `registerIssuedPath` still enforces the allow-list.
  ipcMain.handle(IPC.project.prepareOpen, async (_evt, filePath: unknown): Promise<boolean> => {
    const canonical = canonicaliseProjectPath(filePath)
    if (canonical === null) return false
    try {
      const content = await readFile(canonical, 'utf8')
      // Project JSON may contain `filePath` anywhere in the tree. Project-internal
      // artifact paths are stored relative to the project folder (portability);
      // resolve them against it before allow-listing so the renderer can read them.
      const projectDir = dirname(canonical)
      // Stems for this project live beside it; trust that folder for reads + sidecar.
      registerStemsWriteRoot(join(projectDir, 'Stems'))
      // Samples (and their music-sample sidecars) likewise live beside the project.
      registerSamplesWriteRoot(join(projectDir, 'Samples'))
      // Central per-source metadata/cover store (keyed by media GUID) beside the project.
      registerProjectMediaRoots(projectDir)
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (parseErr) {
        logMain('WARN ', 'project:prepareOpen', `malformed project JSON at ${canonical}:`, parseErr)
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
              registerIssuedPath(isAbsolute(v) ? v : join(projectDir, v))
            } else {
              visit(v)
            }
          }
        }
      }
      visit(parsed)
      return true
    } catch (err) {
      logMain('WARN ', 'project:prepareOpen', `could not read project file ${canonical}:`, err)
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
