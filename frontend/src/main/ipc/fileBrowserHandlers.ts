// File-browser IPC handlers: the folders the user has added to the library file
// browser, and the index of each one. Adding a folder is the consent step — it
// is the only way a path enters the browser's allow-list, so crawling and reads
// stay confined to folders the user picked in the native dialog. The crawl runs
// once per folder and is cached to disk; everything the tree shows is answered
// from that index rather than from the filesystem. Registered from main/index.ts.

import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { FileBrowserFolderIndex, FileBrowserIndexProgress } from '../../shared/types'
import {
  canonicalisePath,
  registerFileBrowserRoot,
  unregisterFileBrowserRoot
} from '../audioPaths'
import { forgetFolderIndex, getFolderIndex } from '../fileBrowserIndex'
import { logMain } from '../log'
import type { PrefsService } from '../prefsService'

export interface FileBrowserHandlersContext {
  getMainWindow(): BrowserWindow | null
  prefs: PrefsService
}

/**
 * Re-trust folders persisted from a previous run. Called during startup, before
 * the renderer can ask for an index.
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

  function emptyIndex(root: string): FileBrowserFolderIndex {
    return { root, folders: {}, tags: {}, indexedAt: 0 }
  }

  /**
   * Forward a crawl to the renderer as it happens, so the tree fills in folder
   * by folder instead of staying empty until a large library is finished. The
   * window can close mid-crawl, so the send is guarded rather than assumed.
   */
  function reportProgress(progress: FileBrowserIndexProgress): void {
    const win = ctx.getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.fileBrowser.indexProgress, progress)
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

  ipcMain.handle(IPC.fileBrowser.removeFolder, async (_evt, folder: unknown): Promise<string[]> => {
    if (typeof folder !== 'string' || folder === '') return savedFolders()
    const target = canonicalisePath(folder).toLowerCase()
    const next = savedFolders().filter((f) => canonicalisePath(f).toLowerCase() !== target)
    unregisterFileBrowserRoot(folder)
    persistFolders(next)
    // After un-registering, so a cached listing cannot outlive the consent.
    await forgetFolderIndex(folder)
    return next
  })

  /**
   * The index for one added root, crawled on first use and reused from then on.
   * The renderer holds the result for the session, so this is answered once per
   * folder per launch — or served straight from the startup cache.
   */
  ipcMain.handle(IPC.fileBrowser.getIndex, async (_evt, root: unknown) => {
    if (typeof root !== 'string' || root === '') return emptyIndex('')
    return await getFolderIndex(root, { onProgress: reportProgress })
  })

  /** Re-crawl a root, picking up files added or retagged on disk since. */
  ipcMain.handle(IPC.fileBrowser.refreshIndex, async (_evt, root: unknown) => {
    if (typeof root !== 'string' || root === '') return emptyIndex('')
    logMain('INFO ', 'fileBrowser:refreshIndex', 're-crawling:', root)
    return await getFolderIndex(root, { refresh: true, onProgress: reportProgress })
  })
}
