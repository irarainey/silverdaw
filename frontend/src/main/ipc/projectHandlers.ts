// Project file lifecycle IPC handlers: native open/save dialogs, existence check,
// the Recent Projects MRU, project pre-open path allow-listing, and consuming a
// pending launch path. Registered from main/index.ts.

import { ipcMain, app, dialog, type BrowserWindow } from 'electron'
import { readFile, mkdir, cp } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import { registerIssuedPath, registerStemsWriteRoot, registerSamplesWriteRoot, registerProjectMediaRoots, getProjectMediaDirs } from '../audioPaths'
import { canonicaliseProjectPath, projectFolderPath } from '../projectPaths'
import { sweepEmptyArtifactSubdirs } from '../projectFileCleanup'
import { ensureWritableTargetDir } from '../writableTarget'
import type { PrefsService } from '../prefsService'
import type { RecentProject } from '../../shared/types'
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
    // Accept the {path,name} form (current) and a bare string (defensive/legacy).
    let path: string | undefined
    let name: string | undefined
    if (typeof value === 'string') {
      path = value
    } else if (value && typeof value === 'object') {
      const candidate = value as { path?: unknown; name?: unknown }
      if (typeof candidate.path === 'string') path = candidate.path
      if (typeof candidate.name === 'string') name = candidate.name
    }
    if (!path || path.length === 0) return
    if (prefs.bumpRecentProject(path, name)) prefs.flushSaveSync()
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
      if (!(await ensureWritableTargetDir(win, dirname(target)))) return null
      // The backend writes this project's stems beside the file; trust that folder
      // for renderer reads + sidecar writes ahead of the first separation.
      registerStemsWriteRoot(join(dirname(target), 'stems'))
      // Likewise the project's samples folder, where music samples persist their
      // inherited metadata/cover sidecar.
      registerSamplesWriteRoot(join(dirname(target), 'samples'))
      // Clear any empty per-source artifact folder left behind by an earlier removal.
      void sweepEmptyArtifactSubdirs(join(dirname(target), 'stems'))
      void sweepEmptyArtifactSubdirs(join(dirname(target), 'samples'))
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

  // Pre-register a project's audio paths before load: trust its artifact roots (stems /
  // samples / media store) for reads, and allow-list every `filePath` in the project JSON.
  // `contentPath` is the file to scan (the .silverdaw being loaded); `rootsDir` is the folder
  // the project's artifacts live beside. For a normal open these are the same directory. For a
  // RECOVERY they differ: the content is the autosave copy in the autosave bucket, but the
  // artifacts (samples, stems, media store) live beside the ORIGINAL project file — so the roots
  // must be registered there, not against the autosave directory.
  async function prepareProjectPaths(contentPath: string, rootsDir: string): Promise<boolean> {
    try {
      const content = await readFile(contentPath, 'utf8')
      // Stems + samples for this project live beside it; trust those folders for reads + sidecar.
      const stemsRoot = join(rootsDir, 'stems')
      const samplesRoot = join(rootsDir, 'samples')
      registerStemsWriteRoot(stemsRoot)
      registerSamplesWriteRoot(samplesRoot)
      // Clear any empty per-source artifact folder left behind by a removal whose folder couldn't
      // be deleted last session. Best-effort; never touches folders that still hold files.
      void sweepEmptyArtifactSubdirs(stemsRoot)
      void sweepEmptyArtifactSubdirs(samplesRoot)
      // Central per-source metadata/cover store (keyed by media GUID) beside the project.
      registerProjectMediaRoots(rootsDir)
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (parseErr) {
        logMain('WARN ', 'project:prepare', `malformed project JSON at ${contentPath}:`, parseErr)
        return false
      }
      // Project JSON may contain `filePath` anywhere in the tree. Project-internal artifact paths
      // are stored relative to the project folder (portability); resolve them against `rootsDir`
      // before allow-listing so the renderer can read them. (Autosave content stores these
      // absolute, so resolution is a no-op there.)
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) visit(item)
          return
        }
        if (node !== null && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            if (k === 'filePath' && typeof v === 'string' && v.length > 0) {
              registerIssuedPath(isAbsolute(v) ? v : join(rootsDir, v))
            } else {
              visit(v)
            }
          }
        }
      }
      visit(parsed)
      return true
    } catch (err) {
      logMain('WARN ', 'project:prepare', `could not read project file ${contentPath}:`, err)
      return false
    }
  }

  // Pre-register project audio paths; `registerIssuedPath` still enforces the allow-list.
  ipcMain.handle(IPC.project.prepareOpen, async (_evt, filePath: unknown): Promise<boolean> => {
    const canonical = canonicaliseProjectPath(filePath)
    if (canonical === null) return false
    return prepareProjectPaths(canonical, dirname(canonical))
  })

  // Recovery preloads from the autosave copy, but the project's artifacts live beside the ORIGINAL
  // file (or in the temp workspace if it was never saved). Allow-list the autosave content while
  // registering the artifact roots at the real project folder, so samples / stems / cover art +
  // tags resolve to where they actually are — not the autosave bucket (which broke restored links).
  ipcMain.handle(
    IPC.project.prepareRecovery,
    async (_evt, autosavePath: unknown, originalPath: unknown): Promise<boolean> => {
      const canonicalAutosave = canonicaliseProjectPath(autosavePath)
      if (canonicalAutosave === null) return false
      const canonicalOriginal =
        typeof originalPath === 'string' && originalPath.length > 0
          ? canonicaliseProjectPath(originalPath)
          : null
      // Saved project → artifacts beside the original file; never-saved → the temp workspace
      // (where unsaved imports/samples/stems were written, mirroring stemHandlers startup).
      const rootsDir = canonicalOriginal !== null
        ? dirname(canonicalOriginal)
        : join(app.getPath('temp'), 'Silverdaw')
      return prepareProjectPaths(canonicalAutosave, rootsDir)
    }
  )

  // Consume a pending launch path once so renderer reloads do not reopen it.
  ipcMain.handle(IPC.project.consumePendingOpenPath, (): string | null => ctx.consumePendingOpenPath())

  // ─── Recent projects (MRU) ─────────────────────────────────────────────
  ipcMain.handle(IPC.prefs.getRecentProjects, (): RecentProject[] =>
    prefs.get().recentProjects.map((p) => ({ ...p }))
  )

  ipcMain.on(IPC.prefs.removeRecentProject, (_evt, value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return
    const key = value.toLowerCase()
    const store = prefs.get()
    const before = store.recentProjects.length
    store.recentProjects = store.recentProjects.filter((p) => p.path.toLowerCase() !== key)
    if (store.recentProjects.length !== before) prefs.flushSaveSync()
  })

  ipcMain.on(IPC.prefs.clearRecentProjects, () => {
    const store = prefs.get()
    if (store.recentProjects.length === 0) return
    store.recentProjects = []
    prefs.flushSaveSync()
  })
}
