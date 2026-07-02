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
import { MEL_BAND_ROFORMER_MANIFEST, ROFORMER_CORE_FILENAME } from '../stems/melBandRoformerModel'
import { BS_ROFORMER_RHYTHM_MANIFEST, RHYTHM_CORE_FILENAME } from '../stems/bsRoformerRhythmModel'
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
  // point the backend migrates them beside the project file). Saved-project stems
  // dirs are registered separately in projectHandlers.
  registerStemsWriteRoot(join(app.getPath('temp'), 'Silverdaw', 'stems'))
  // Unsaved projects likewise export samples into the temp workspace; trust it for
  // renderer reads and music-sample sidecar writes until the project is saved (the
  // backend then migrates them beside the project file). Saved-project samples dirs
  // are registered separately in projectHandlers.
  registerSamplesWriteRoot(join(app.getPath('temp'), 'Silverdaw', 'samples'))
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
      // Deliberately 'basic', not 'complete'. The 'complete' query forces the GPU
      // process to build a GL context and gather renderer strings, which crashes
      // that process on some drivers in packaged (installed) builds — a native
      // crash a JS try/catch cannot contain, taking the whole app down when the
      // Stems tab opens. 'basic' returns the vendorId our detector needs to answer
      // "is there a real GPU?" without touching the GL path. The trade-off is we
      // lose the friendly adapter name (the UI falls back to "compatible adapter").
      const info = await app.getGPUInfo('basic')
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

  // ─── Optional Mel-Band RoFormer "Vocal Quality Pack" ────────────────────────
  const vocalPackManagedDir = join(app.getPath('userData'), 'models', MEL_BAND_ROFORMER_MANIFEST.id)
  // A located override directory (a user-supplied / manually-placed copy) wins;
  // otherwise the app-managed download location is used. Resolved per call.
  const effectiveVocalPackDir = (): string =>
    sanitiseStemModelDir(prefs.get().paths.vocalPackDir) ?? vocalPackManagedDir
  const vocalPackStoreFor = (dir: string): ModelStore =>
    new ModelStore({ manifest: MEL_BAND_ROFORMER_MANIFEST, modelDir: dir })
  let activePackDownload: AbortController | null = null

  ipcMain.handle(IPC.stems.getVocalPackState, async (): Promise<StemModelState> => {
    const state = await vocalPackStoreFor(effectiveVocalPackDir()).readInstallState()
    return {
      installed: state.installed,
      presentBytes: state.presentBytes,
      totalBytes: state.totalBytes,
      fileCount: state.files.length
    }
  })

  // Resolve the installed core .onnx path for the separation request (the backend
  // loads its sibling .onnx.data automatically). Empty string when not installed.
  ipcMain.handle(IPC.stems.getVocalPackPath, async (): Promise<string> => {
    const dir = effectiveVocalPackDir()
    const state = await vocalPackStoreFor(dir).readInstallState()
    return state.installed ? join(dir, ROFORMER_CORE_FILENAME) : ''
  })

  ipcMain.handle(IPC.stems.ensureVocalPack, async (): Promise<EnsureStemModelResult> => {
    if (activePackDownload) {
      return { ok: false, error: 'A vocal pack download is already in progress.' }
    }
    const controller = new AbortController()
    activePackDownload = controller
    try {
      // Download always targets the app-managed location; a successful fetch makes
      // it authoritative, so any stale located override is cleared.
      await vocalPackStoreFor(vocalPackManagedDir).ensureDownloaded((progress) => {
        const win = ctx.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.stems.vocalPackDownloadProgress, progress)
        }
      }, controller.signal)
      if (prefs.get().paths.vocalPackDir !== undefined) {
        prefs.get().paths.vocalPackDir = undefined
        prefs.flushSaveSync()
      }
      return { ok: true }
    } catch (err) {
      if (err instanceof ModelDownloadError) {
        return { ok: false, error: err.message, fileName: err.fileName }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      activePackDownload = null
    }
  })

  // Validate a user-supplied folder against the manifest; on success stamp it
  // with the revision sentinel and persist it as the vocal-pack override dir.
  ipcMain.handle(
    IPC.stems.locateVocalPack,
    async (_evt, dir: unknown): Promise<LocateStemModelResult> => {
      const candidate = sanitiseStemModelDir(dir)
      if (!candidate) return { ok: false, error: 'No folder was selected.' }
      try {
        await vocalPackStoreFor(candidate).adoptDirectory(candidate)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      prefs.get().paths.vocalPackDir = candidate
      prefs.flushSaveSync()
      return { ok: true, directory: candidate }
    }
  )

  ipcMain.on(IPC.stems.cancelVocalPackDownload, () => {
    activePackDownload?.abort()
  })

  // ─── Optional 4-stem BS-RoFormer "Rhythm Quality Pack" ──────────────────────
  const rhythmPackManagedDir = join(app.getPath('userData'), 'models', BS_ROFORMER_RHYTHM_MANIFEST.id)
  const effectiveRhythmPackDir = (): string =>
    sanitiseStemModelDir(prefs.get().paths.rhythmPackDir) ?? rhythmPackManagedDir
  const rhythmPackStoreFor = (dir: string): ModelStore =>
    new ModelStore({ manifest: BS_ROFORMER_RHYTHM_MANIFEST, modelDir: dir })
  let activeRhythmDownload: AbortController | null = null

  ipcMain.handle(IPC.stems.getRhythmPackState, async (): Promise<StemModelState> => {
    const state = await rhythmPackStoreFor(effectiveRhythmPackDir()).readInstallState()
    return {
      installed: state.installed,
      presentBytes: state.presentBytes,
      totalBytes: state.totalBytes,
      fileCount: state.files.length
    }
  })

  // Resolve the installed core .onnx path for the separation request (a single
  // self-contained graph — no sibling .data). Empty string when not installed.
  ipcMain.handle(IPC.stems.getRhythmPackPath, async (): Promise<string> => {
    const dir = effectiveRhythmPackDir()
    const state = await rhythmPackStoreFor(dir).readInstallState()
    return state.installed ? join(dir, RHYTHM_CORE_FILENAME) : ''
  })

  ipcMain.handle(IPC.stems.ensureRhythmPack, async (): Promise<EnsureStemModelResult> => {
    if (activeRhythmDownload) {
      return { ok: false, error: 'A rhythm pack download is already in progress.' }
    }
    const controller = new AbortController()
    activeRhythmDownload = controller
    try {
      await rhythmPackStoreFor(rhythmPackManagedDir).ensureDownloaded((progress) => {
        const win = ctx.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.stems.rhythmPackDownloadProgress, progress)
        }
      }, controller.signal)
      if (prefs.get().paths.rhythmPackDir !== undefined) {
        prefs.get().paths.rhythmPackDir = undefined
        prefs.flushSaveSync()
      }
      return { ok: true }
    } catch (err) {
      if (err instanceof ModelDownloadError) {
        return { ok: false, error: err.message, fileName: err.fileName }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      activeRhythmDownload = null
    }
  })

  // Validate a user-supplied folder against the manifest; on success stamp it
  // with the revision sentinel and persist it as the rhythm-pack override dir.
  ipcMain.handle(
    IPC.stems.locateRhythmPack,
    async (_evt, dir: unknown): Promise<LocateStemModelResult> => {
      const candidate = sanitiseStemModelDir(dir)
      if (!candidate) return { ok: false, error: 'No folder was selected.' }
      try {
        await rhythmPackStoreFor(candidate).adoptDirectory(candidate)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      prefs.get().paths.rhythmPackDir = candidate
      prefs.flushSaveSync()
      return { ok: true, directory: candidate }
    }
  )

  ipcMain.on(IPC.stems.cancelRhythmPackDownload, () => {
    activeRhythmDownload?.abort()
  })
}
