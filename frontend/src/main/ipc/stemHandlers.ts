// Stem-separation model IPC handlers. The backend has no network stack
// (JUCE_USE_CURL=0), so the ~1.2 GB htdemucs model is fetched here in main via
// the injected-dependency `ModelStore` and handed to the backend as a directory
// path. Handlers: query install state, resolve the model directory, and run a
// cancellable download that streams progress to the renderer. Registered from
// main/index.ts.

import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import type { EnsureStemModelResult, StemModelState } from '../../shared/types'
import { HTDEMUCS_FT_MANIFEST } from '../stems/htdemucsModel'
import { ModelStore, ModelDownloadError } from '../stems/modelStore'
import { registerTrustedReadRoot } from '../audioPaths'

export interface StemHandlersContext {
  getMainWindow(): BrowserWindow | null
}

export function registerStemHandlers(ctx: StemHandlersContext): void {
  const modelDir = join(app.getPath('userData'), 'models', HTDEMUCS_FT_MANIFEST.id)
  const store = new ModelStore({ manifest: HTDEMUCS_FT_MANIFEST, modelDir })
  // The backend writes separated stems under this app-owned tree; trust it so the
  // renderer can read them on STEM_READY (those paths are never issued via a dialog).
  registerTrustedReadRoot(join(app.getPath('userData'), 'stems'))
  // The backend separator is single-slot, so at most one download is in flight.
  let activeDownload: AbortController | null = null

  ipcMain.handle(IPC.stems.getModelDir, async (): Promise<string> => store.directory)

  ipcMain.handle(IPC.stems.getModelState, async (): Promise<StemModelState> => {
    const state = await store.readInstallState()
    return {
      installed: state.installed,
      presentBytes: state.presentBytes,
      totalBytes: state.totalBytes,
      fileCount: state.files.length
    }
  })

  ipcMain.handle(IPC.stems.ensureModel, async (): Promise<EnsureStemModelResult> => {
    if (activeDownload) {
      return { ok: false, error: 'A model download is already in progress.' }
    }
    const controller = new AbortController()
    activeDownload = controller
    try {
      await store.ensureDownloaded((progress) => {
        const win = ctx.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.stems.modelDownloadProgress, progress)
        }
      }, controller.signal)
      return { ok: true }
    } catch (err) {
      if (err instanceof ModelDownloadError) {
        return { ok: false, error: err.message, fileName: err.fileName }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      activeDownload = null
    }
  })

  ipcMain.on(IPC.stems.cancelModelDownload, () => {
    activeDownload?.abort()
  })
}
