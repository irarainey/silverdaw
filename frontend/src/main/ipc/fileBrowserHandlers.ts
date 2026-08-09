// File-browser IPC handlers: the folders the user has added to the library file
// browser, and lazy per-directory listings of subfolders and importable audio
// files. Adding a folder is the consent step — it is the only way a path enters
// the browser's allow-list, so listings and reads stay confined to folders the
// user picked in the native dialog. Registered from main/index.ts.

import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import type { FileBrowserEntry } from '../../shared/types'
import {
  AUDIO_FILE_EXTENSIONS,
  canonicalisePath,
  isWithinFileBrowserRoot,
  registerFileBrowserRoot,
  unregisterFileBrowserRoot
} from '../audioPaths'
import { logMain } from '../log'
import type { PrefsService } from '../prefsService'

export interface FileBrowserHandlersContext {
  getMainWindow(): BrowserWindow | null
  prefs: PrefsService
}

const AUDIO_EXTENSIONS_SET: ReadonlySet<string> = new Set<string>(AUDIO_FILE_EXTENSIONS)

function isImportableAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS_SET.has(extname(name).replace(/^\./, '').toLowerCase())
}

// Folders first, then files; both A-Z so the tree reads predictably. Uses locale
// compare so accented titles sort where a user expects them to.
function compareEntries(a: FileBrowserEntry, b: FileBrowserEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Re-trust folders persisted from a previous run. Called during startup, before
 * the renderer can ask for a listing.
 */
export function restoreFileBrowserRoots(folders: readonly string[]): void {
  for (const folder of folders) registerFileBrowserRoot(folder)
}

export function registerFileBrowserHandlers(ctx: FileBrowserHandlersContext): void {
  const { prefs } = ctx

  function savedFolders(): string[] {
    return [...prefs.get().ui.fileBrowserFolders]
  }

  function persistFolders(folders: string[]): void {
    prefs.get().ui.fileBrowserFolders = folders
    prefs.flushSaveSync()
  }

  ipcMain.handle(IPC.fileBrowser.listFolders, () => savedFolders())

  ipcMain.handle(IPC.fileBrowser.addFolder, async (): Promise<string[]> => {
    const win = ctx.getMainWindow()
    if (!win) return savedFolders()
    const result = await dialog.showOpenDialog(win, {
      title: 'Add Folder to File Browser',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return savedFolders()
    const picked = canonicalisePath(result.filePaths[0])
    const folders = savedFolders()
    if (folders.some((f) => canonicalisePath(f).toLowerCase() === picked.toLowerCase())) {
      return folders
    }
    registerFileBrowserRoot(picked)
    const next = [...folders, picked]
    persistFolders(next)
    return next
  })

  ipcMain.handle(IPC.fileBrowser.removeFolder, (_evt, folder: unknown): string[] => {
    if (typeof folder !== 'string' || folder === '') return savedFolders()
    const target = canonicalisePath(folder).toLowerCase()
    const next = savedFolders().filter((f) => canonicalisePath(f).toLowerCase() !== target)
    unregisterFileBrowserRoot(folder)
    persistFolders(next)
    return next
  })

  ipcMain.handle(IPC.fileBrowser.listDirectory, async (_evt, dir: unknown): Promise<FileBrowserEntry[]> => {
    if (!isWithinFileBrowserRoot(dir)) {
      logMain('WARN ', 'fileBrowser:listDirectory', 'rejected path outside browser roots:', dir)
      return []
    }
    try {
      const dirents = await readdir(dir, { withFileTypes: true })
      const entries: FileBrowserEntry[] = []
      for (const dirent of dirents) {
        // Ignore symlinks: following them would let a link inside a browsed
        // folder reach arbitrary parts of the filesystem.
        if (dirent.isDirectory()) {
          entries.push({ path: join(dir, dirent.name), name: dirent.name, kind: 'directory' })
        } else if (dirent.isFile() && isImportableAudioFile(dirent.name)) {
          entries.push({
            path: join(dir, dirent.name),
            name: basename(dirent.name, extname(dirent.name)),
            kind: 'file'
          })
        }
      }
      return entries.sort(compareEntries)
    } catch (err) {
      logMain('WARN ', 'fileBrowser:listDirectory', 'read failed:', dir, String(err))
      return []
    }
  })
}
