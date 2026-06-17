// Stem-separation model IPC handlers. The backend has no network stack
// (JUCE_USE_CURL=0), so the ~1.2 GB htdemucs model is fetched here in main via
// the injected-dependency `ModelStore` and handed to the backend as a directory
// path. Handlers: query install state, resolve the model directory, run a
// cancellable download that streams progress, locate an existing on-disk copy,
// and report GPU availability for the "use GPU" preference. Registered from
// main/index.ts.

import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import type {
  EnsureStemModelResult,
  LocateStemModelResult,
  StemGpuStatus,
  StemModelInfo,
  StemModelState
} from '../../shared/types'
import { HTDEMUCS_FT_MANIFEST } from '../stems/htdemucsModel'
import { ModelStore, ModelDownloadError } from '../stems/modelStore'
import { detectGpuFromInfo } from '../stems/gpuDetect'
import { sanitiseStemModelDir } from '../preferences'
import type { PrefsService } from '../prefsService'
import { registerStemsWriteRoot, registerSamplesWriteRoot, registerProjectMediaRoots } from '../audioPaths'

export interface StemHandlersContext {
  getMainWindow(): BrowserWindow | null
  prefs: PrefsService
}

export function registerStemHandlers(ctx: StemHandlersContext): void {
  const { prefs } = ctx
  const managedModelDir = join(app.getPath('userData'), 'models', HTDEMUCS_FT_MANIFEST.id)
  // Unsaved projects write separated stems into a temporary workspace; trust it
  // for renderer reads and sidecar writes until the project is saved (at which
  // point the backend migrates them beside the project file). Saved-project Stems
  // dirs are registered separately in projectHandlers.
  registerStemsWriteRoot(join(app.getPath('temp'), 'Silverdaw', 'Stems'))
  // Unsaved projects likewise export samples into the temp workspace; trust it for
  // renderer reads and music-sample sidecar writes until the project is saved (the
  // backend then migrates them beside the project file). Saved-project Samples dirs
  // are registered separately in projectHandlers.
  registerSamplesWriteRoot(join(app.getPath('temp'), 'Silverdaw', 'Samples'))
  // Central per-source metadata/cover store while unsaved (migrated beside the project on save).
  registerProjectMediaRoots(join(app.getPath('temp'), 'Silverdaw'))
  // The backend separator is single-slot, so at most one download is in flight.
  let activeDownload: AbortController | null = null

  // A located override directory (if any) wins; otherwise the app-managed
  // download location is used. Resolved per call so a mid-session locate or
  // download takes effect without restarting.
  function effectiveModelDir(): string {
    return sanitiseStemModelDir(prefs.get().paths.stemModelDir) ?? managedModelDir
  }

  function storeForDir(dir: string): ModelStore {
    return new ModelStore({ manifest: HTDEMUCS_FT_MANIFEST, modelDir: dir })
  }

  ipcMain.handle(IPC.stems.getModelDir, async (): Promise<string> => effectiveModelDir())

  ipcMain.handle(IPC.stems.getModelState, async (): Promise<StemModelState> => {
    const state = await storeForDir(effectiveModelDir()).readInstallState()
    return {
      installed: state.installed,
      presentBytes: state.presentBytes,
      totalBytes: state.totalBytes,
      fileCount: state.files.length
    }
  })

  ipcMain.handle(IPC.stems.getModelInfo, async (): Promise<StemModelInfo> => {
    const override = sanitiseStemModelDir(prefs.get().paths.stemModelDir)
    const dir = override ?? managedModelDir
    const installed = (await storeForDir(dir).readInstallState()).installed
    return { directory: dir, located: override !== undefined, installed }
  })

  ipcMain.handle(IPC.stems.getGpuStatus, async (): Promise<StemGpuStatus> => {
    try {
      const info = await app.getGPUInfo('complete')
      return detectGpuFromInfo(info)
    } catch {
      return { available: false, name: null }
    }
  })

  // Validate a user-supplied folder against the manifest; on success stamp it
  // with the revision sentinel and persist it as the override directory.
  ipcMain.handle(
    IPC.stems.locateModel,
    async (_evt, dir: unknown): Promise<LocateStemModelResult> => {
      const candidate = sanitiseStemModelDir(dir)
      if (!candidate) return { ok: false, error: 'No folder was selected.' }
      try {
        await storeForDir(candidate).adoptDirectory(candidate)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      prefs.get().paths.stemModelDir = candidate
      prefs.flushSaveSync()
      return { ok: true, directory: candidate }
    }
  )

  ipcMain.handle(IPC.stems.ensureModel, async (): Promise<EnsureStemModelResult> => {
    if (activeDownload) {
      return { ok: false, error: 'A model download is already in progress.' }
    }
    // Download always targets the app-managed location; a successful fetch makes
    // it authoritative, so any stale located override is cleared.
    const store = storeForDir(managedModelDir)
    const controller = new AbortController()
    activeDownload = controller
    try {
      await store.ensureDownloaded((progress) => {
        const win = ctx.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.stems.modelDownloadProgress, progress)
        }
      }, controller.signal)
      if (prefs.get().paths.stemModelDir !== undefined) {
        prefs.get().paths.stemModelDir = undefined
        prefs.flushSaveSync()
      }
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
