// Least-privilege preload API exposed through context isolation.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AudioMetadata,
  DebugPreferences,
  MidiDeckSelection,
  OpenedAudioFile,
  UiPreferences
} from '../shared/types'
import type {
  EnsureStemModelResult,
  LocateStemModelResult,
  RecentProject,
  StemGpuStatus,
  StemModelDownloadProgress,
  StemModelInfo,
  StemModelState,
  StemPrefsDto,
  BrakePrefsDto,
  BackspinPrefsDto
} from '../shared/types'
import { IPC, type BackendStatus } from '../shared/ipc-channels'

export type { AudioMetadata, DebugPreferences, OpenedAudioFile, UiPreferences }

const api = {
  menuAction: (action: string): void => {
    ipcRenderer.send(IPC.menu.action, action)
  },
  minimizeWindow: (): void => {
    ipcRenderer.send(IPC.window.minimize)
  },
  toggleMaximizeWindow: (): void => {
    ipcRenderer.send(IPC.window.toggleMaximize)
  },
  closeWindow: (): void => {
    ipcRenderer.send(IPC.window.close)
  },
  openAudioFile: (): Promise<OpenedAudioFile | null> => ipcRenderer.invoke(IPC.audio.open),
  openAudioFiles: (): Promise<OpenedAudioFile[]> => ipcRenderer.invoke(IPC.audio.openMany),
  /** Relink picker: returns a path only; the backend reloads the source. */
  chooseAudioFile: (args: {
    title?: string
    defaultPath?: string
  }): Promise<string | null> => ipcRenderer.invoke(IPC.audio.chooseFile, args),
  /** Main only reads audio paths previously surfaced through trusted UI. */
  readAudioFile: (filePath: string): Promise<OpenedAudioFile | null> =>
    ipcRenderer.invoke(IPC.audio.readFile, filePath),
  /** Same path allow-list as `readAudioFile`; returns display metadata or null. */
  readAudioMetadata: (filePath: string): Promise<AudioMetadata | null> =>
    ipcRenderer.invoke(IPC.audio.readMetadata, filePath),
  /** Resolve and register an OS drag-dropped file path for later allowed reads. */
  getPathForFile: (file: File): string => {
    try {
      const filePath = webUtils.getPathForFile(file)
      if (filePath !== '') {
        // Fire-and-forget: a racing read simply fails and the user can re-drop.
        ipcRenderer.send(IPC.audio.registerDroppedPath, filePath)
      }
      return filePath
    } catch {
      return ''
    }
  },
  onMenuAction: (handler: (action: string) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, action: string): void => handler(action)
    ipcRenderer.on(IPC.menu.action, listener)
    return () => ipcRenderer.removeListener(IPC.menu.action, listener)
  },
  getUiPreferences: (): Promise<UiPreferences> => ipcRenderer.invoke(IPC.prefs.getUi),
  setUiPreferences: (partial: Partial<UiPreferences>): void => {
    ipcRenderer.send(IPC.prefs.setUi, partial)
  },
  /** Main-selected backend port; never hardcode it in renderer code. */
  getBridgePort: (): Promise<number> => ipcRenderer.invoke(IPC.bridge.getPort),
  /** Per-session bridge AUTH token, exposed only through trusted preload IPC. */
  getBridgeToken: (): Promise<string> => ipcRenderer.invoke(IPC.bridge.getToken),
  /** Watchdog restart; supervisor keeps the same port/token for reconnect. */
  restartBackend: (reason: string): Promise<void> => ipcRenderer.invoke(IPC.backend.restart, reason),
  onBackendStatus: (handler: (status: BackendStatus) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, status: BackendStatus): void => handler(status)
    ipcRenderer.on(IPC.backend.status, listener)
    return () => ipcRenderer.removeListener(IPC.backend.status, listener)
  },
  /** Write planar decoded PCM to a cached WAV path the backend can read. */
  writeTempWav: (args: {
    sourcePath: string
    channels: Float32Array[]
    sampleRate: number
  }): Promise<string | null> => ipcRenderer.invoke(IPC.audio.writeTempWav, args),
  /** Batched renderer logs preserve original event timestamps across IPC. */
  logBatch: (
    entries: ReadonlyArray<{ level: string; tag: string; message: string; timestamp: number }>
  ): Promise<void> => ipcRenderer.invoke(IPC.log.appendBatch, entries),
  getAppInfo: (): Promise<{
    appVersion: string
    electron: string
    chromium: string
    node: string
  }> => ipcRenderer.invoke(IPC.app.getInfo),
  /** Main only opens http/https URLs externally. */
  openExternal: (url: string): void => {
    ipcRenderer.send(IPC.app.openExternal, url)
  },
  /** Zip the current run's logs, reveal them, and open a support email draft. */
  sendDiagnostics: (): Promise<boolean> => ipcRenderer.invoke(IPC.app.sendDiagnostics),
  // ─── Project file lifecycle ──────────────────────────────────────────────
  setLastProjectPath: (path: string, name: string): void => {
    ipcRenderer.send(IPC.project.setLastPath, { path, name })
  },
  projectFileExists: (path: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.project.fileExists, path),
  chooseProjectOpen: (): Promise<string | null> => ipcRenderer.invoke(IPC.project.chooseOpen),
  chooseProjectSaveAs: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.project.chooseSaveAs, defaultName),
  chooseMixdownSaveAs: (
    defaultPath: string,
    format: 'wav' | 'mp3' | 'flac' | 'aiff'
  ): Promise<string | null> => ipcRenderer.invoke(IPC.mixdown.chooseSaveAs, defaultPath, format),
  /** Mixdown defaults live under a `mixdown/` subdirectory. */
  resolveMixdownDefaultPath: (
    projectFilePath: string | null,
    projectName: string,
    format: 'wav' | 'mp3' | 'flac' | 'aiff'
  ): Promise<string> =>
    ipcRenderer.invoke(IPC.mixdown.resolveDefaultPath, projectFilePath, projectName, format),
  /** Overwrite confirmation for manually typed mixdown paths. */
  confirmMixdownOverwrite: (filePath: string): Promise<'overwrite' | 'cancel' | 'not-found'> =>
    ipcRenderer.invoke(IPC.mixdown.confirmOverwrite, filePath),
  /** Pre-register project audio paths for trusted post-load reads. */
  prepareProjectOpen: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.project.prepareOpen, filePath),
  /** Pre-register a recovered project's audio paths: allow-list the autosave content but trust the
   *  ORIGINAL project folder's artifact roots (samples/stems/media), so restored links resolve. */
  prepareProjectRecovery: (autosavePath: string, originalPath: string | null): Promise<boolean> =>
    ipcRenderer.invoke(IPC.project.prepareRecovery, autosavePath, originalPath),
  /** Consume a pending `.silverdaw` launch path exactly once. */
  consumePendingOpenPath: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.project.consumePendingOpenPath),
  /** Subscribe to project-open pushes from a collapsed second instance. */
  onOpenProjectFromPath: (handler: (filePath: string) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, filePath: string): void => handler(filePath)
    ipcRenderer.on(IPC.project.openFromPath, listener)
    return () => ipcRenderer.removeListener(IPC.project.openFromPath, listener)
  },
  /** Read backend-produced peaks bytes from the validated cache directory. */
  readPeaksCacheFile: (cachePath: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke(IPC.peaks.readCacheFile, cachePath),
  // ─── Developer options ─────────────────────────────────────────────────
  /** Startup-only debug gates for logging and DevTools. */
  getStartupDebugPreferences: (): Promise<DebugPreferences> => ipcRenderer.invoke(IPC.debug.getStartupPrefs),
  getDebugPreferences: (): Promise<DebugPreferences> => ipcRenderer.invoke(IPC.debug.getPrefs),
  setDebugPreferences: (partial: Partial<DebugPreferences>): void => {
    ipcRenderer.send(IPC.debug.setPrefs, partial)
  },
  // ─── Quality-of-life preferences ───────────────────────────────────────
  getQolPrefs: (): Promise<{
    toasts: { enabled: boolean }
    paths: { defaultProjectDir: string; defaultClipDir: string }
  }> => ipcRenderer.invoke(IPC.prefs.getQol),
  /** QoL preferences apply immediately, unlike startup debug gates. */
  setQolPrefs: (partial: {
    toasts?: { enabled?: boolean }
    paths?: { defaultProjectDir?: string; defaultClipDir?: string }
  }): void => {
    ipcRenderer.send(IPC.prefs.setQol, partial)
  },
  chooseDirectory: (args: {
    title?: string
    defaultPath?: string
  }): Promise<string | null> => ipcRenderer.invoke(IPC.prefs.chooseDirectory, args),
  // ─── Recent projects ────────────────────────────────────────────────────
  getRecentProjects: (): Promise<RecentProject[]> => ipcRenderer.invoke(IPC.prefs.getRecentProjects),
  removeRecentProject: (filePath: string): void => {
    ipcRenderer.send(IPC.prefs.removeRecentProject, filePath)
  },
  clearRecentProjects: (): void => {
    ipcRenderer.send(IPC.prefs.clearRecentProjects)
  },
  // ─── Autosave configuration ─────────────────────────────────────────────
  getAutosaveConfig: (): Promise<{ enabled: boolean; intervalSeconds: number }> =>
    ipcRenderer.invoke(IPC.prefs.getAutosaveConfig),
  /** Autosave interval is clamped server-side to 5..600 seconds. */
  setAutosaveConfig: (partial: { enabled?: boolean; intervalSeconds?: number }): void => {
    ipcRenderer.send(IPC.prefs.setAutosaveConfig, partial)
  },
  // ─── Audio output device preference ─────────────────────────────────────
  getAudioOutput: (): Promise<{ typeName: string | null; deviceName: string | null }> =>
    ipcRenderer.invoke(IPC.prefs.getAudioOutput),
  /** Persist only backend-acknowledged audio device selections. */
  setAudioOutput: (partial: { typeName: string | null; deviceName: string | null }): void => {
    ipcRenderer.send(IPC.prefs.setAudioOutput, partial)
  },
  // ─── Per-device output keep-awake toggles (on / off) ────────────────────
  getKeepAwakeByDevice: (): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke(IPC.prefs.getKeepAwakeByDevice),
  setKeepAwakeForDevice: (deviceName: string, enabled: boolean): void => {
    ipcRenderer.send(IPC.prefs.setKeepAwakeForDevice, deviceName, enabled)
  },
  getEnabledMidiInputs: (): Promise<Record<string, boolean>> =>
    ipcRenderer.invoke(IPC.prefs.getEnabledMidiInputs),
  setMidiInputEnabled: (identifier: string, enabled: boolean): void => {
    ipcRenderer.send(IPC.prefs.setMidiInputEnabled, identifier, enabled)
  },
  getMidiDeckSelections: (): Promise<Record<string, MidiDeckSelection>> =>
    ipcRenderer.invoke(IPC.prefs.getMidiDeckSelections),
  setMidiDeckSelection: (identifier: string, selection: MidiDeckSelection): void => {
    ipcRenderer.send(IPC.prefs.setMidiDeckSelection, identifier, selection)
  },
  // ─── Stem-separation preferences ────────────────────────────────────────
  getStemPrefs: (): Promise<StemPrefsDto> => ipcRenderer.invoke(IPC.prefs.getStems),
  /** Stem GPU intent is gated on detection but persisted regardless. */
  setStemPrefs: (partial: Partial<StemPrefsDto>): void => {
    ipcRenderer.send(IPC.prefs.setStems, partial)
  },
  // ─── Turntable-brake defaults ───────────────────────────────────────────
  getBrakeSettings: (): Promise<BrakePrefsDto> => ipcRenderer.invoke(IPC.prefs.getBrake),
  setBrakeSettings: (partial: Partial<BrakePrefsDto>): void => {
    ipcRenderer.send(IPC.prefs.setBrake, partial)
  },
  // ─── Turntable-backspin defaults ────────────────────────────────────────
  getBackspinSettings: (): Promise<BackspinPrefsDto> => ipcRenderer.invoke(IPC.prefs.getBackspin),
  setBackspinSettings: (partial: Partial<BackspinPrefsDto>): void => {
    ipcRenderer.send(IPC.prefs.setBackspin, partial)
  },
  // ─── Autosave folder + manifest IPCs ────────────────────────────────────
  /** Resolve an autosave bucket after strict `projectId` validation. */
  resolveAutosaveDir: (
    projectId: string
  ): Promise<{ dir: string; filePath: string } | null> =>
    ipcRenderer.invoke(IPC.autosave.resolveDir, projectId),
  writeAutosaveManifest: (manifest: {
    projectId: string
    originalPath: string | null
    projectName: string
    savedAtIso: string
    pending: boolean
  }): Promise<boolean> => ipcRenderer.invoke(IPC.autosave.writeManifest, manifest),
  /** List autosaves newer than or missing their backing project file. */
  listRecoverableAutosaves: (): Promise<
    Array<{
      projectId: string
      originalPath: string | null
      projectName: string
      autosavePath: string
      savedAtIso: string
      originalExists: boolean
    }>
  > => ipcRenderer.invoke(IPC.autosave.listRecoverable),
  clearAutosave: (projectId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.autosave.clear, projectId),
  // ─── Stem-separation model store ────────────────────────────────────────
  /** Fast presence check for the stem-separation model (size-only, no hashing). */
  getStemModelState: (): Promise<StemModelState> => ipcRenderer.invoke(IPC.stems.getModelState),
  /** Directory the backend loads the ONNX sessions from. */
  getStemModelDir: (): Promise<string> => ipcRenderer.invoke(IPC.stems.getModelDir),
  /** Model location + install + located-override status for the preferences UI. */
  getStemModelInfo: (): Promise<StemModelInfo> => ipcRenderer.invoke(IPC.stems.getModelInfo),
  /** Whether a hardware GPU is present, gating the "use GPU" preference. */
  getStemGpuStatus: (): Promise<StemGpuStatus> => ipcRenderer.invoke(IPC.stems.getGpuStatus),
  /** Adopt an existing on-disk model directory instead of downloading. */
  locateStemModel: (dir: string): Promise<LocateStemModelResult> =>
    ipcRenderer.invoke(IPC.stems.locateModel, dir),
  /** Download + integrity-verify any missing model files; honour an in-flight cancel. */
  ensureStemModel: (): Promise<EnsureStemModelResult> => ipcRenderer.invoke(IPC.stems.ensureModel),
  /** Abort the active model download, if any. */
  cancelStemModelDownload: (): void => {
    ipcRenderer.send(IPC.stems.cancelModelDownload)
  },
  onStemModelDownloadProgress: (
    handler: (progress: StemModelDownloadProgress) => void
  ): (() => void) => {
    const listener = (_evt: IpcRendererEvent, progress: StemModelDownloadProgress): void =>
      handler(progress)
    ipcRenderer.on(IPC.stems.modelDownloadProgress, listener)
    return () => ipcRenderer.removeListener(IPC.stems.modelDownloadProgress, listener)
  },
  // ─── Optional Mel-Band RoFormer "Vocal Quality Pack" ────────────────────────
  /** Install state of the optional higher-quality vocal pack. */
  getVocalPackState: (): Promise<StemModelState> => ipcRenderer.invoke(IPC.stems.getVocalPackState),
  /** Installed pack core `.onnx` path for the request, or '' when not installed. */
  getVocalPackPath: (): Promise<string> => ipcRenderer.invoke(IPC.stems.getVocalPackPath),
  /** Download + integrity-verify the vocal pack; honour an in-flight cancel. */
  ensureVocalPack: (): Promise<EnsureStemModelResult> =>
    ipcRenderer.invoke(IPC.stems.ensureVocalPack),
  /** Adopt a user-supplied folder holding the vocal pack as the override dir. */
  locateVocalPack: (dir: string): Promise<LocateStemModelResult> =>
    ipcRenderer.invoke(IPC.stems.locateVocalPack, dir),
  /** Abort the active vocal-pack download, if any. */
  cancelVocalPackDownload: (): void => {
    ipcRenderer.send(IPC.stems.cancelVocalPackDownload)
  },
  onVocalPackDownloadProgress: (
    handler: (progress: StemModelDownloadProgress) => void
  ): (() => void) => {
    const listener = (_evt: IpcRendererEvent, progress: StemModelDownloadProgress): void =>
      handler(progress)
    ipcRenderer.on(IPC.stems.vocalPackDownloadProgress, listener)
    return () => ipcRenderer.removeListener(IPC.stems.vocalPackDownloadProgress, listener)
  },
  // ─── Optional 4-stem BS-RoFormer "Rhythm Quality Pack" ──────────────────────
  /** Install state of the optional higher-quality drums/bass pack. */
  getRhythmPackState: (): Promise<StemModelState> => ipcRenderer.invoke(IPC.stems.getRhythmPackState),
  /** Installed pack core `.onnx` path for the request, or '' when not installed. */
  getRhythmPackPath: (): Promise<string> => ipcRenderer.invoke(IPC.stems.getRhythmPackPath),
  /** Download + integrity-verify the rhythm pack; honour an in-flight cancel. */
  ensureRhythmPack: (): Promise<EnsureStemModelResult> =>
    ipcRenderer.invoke(IPC.stems.ensureRhythmPack),
  /** Adopt a user-supplied folder holding the rhythm pack as the override dir. */
  locateRhythmPack: (dir: string): Promise<LocateStemModelResult> =>
    ipcRenderer.invoke(IPC.stems.locateRhythmPack, dir),
  /** Abort the active rhythm-pack download, if any. */
  cancelRhythmPackDownload: (): void => {
    ipcRenderer.send(IPC.stems.cancelRhythmPackDownload)
  },
  onRhythmPackDownloadProgress: (
    handler: (progress: StemModelDownloadProgress) => void
  ): (() => void) => {
    const listener = (_evt: IpcRendererEvent, progress: StemModelDownloadProgress): void =>
      handler(progress)
    ipcRenderer.on(IPC.stems.rhythmPackDownloadProgress, listener)
    return () => ipcRenderer.removeListener(IPC.stems.rhythmPackDownloadProgress, listener)
  },
  /** Save a source's tags + cover into the project's central metadata/covers store under
   *  its media GUID; main resolves the identity from the source file on disk. */
  saveProjectMedia: (mediaId: string, sourceFilePath: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.media.save, { mediaId, sourceFilePath }),
  /** Read a source's media (tags + cover bytes) back by media GUID, or null when absent. */
  getProjectMedia: (mediaId: string): Promise<AudioMetadata | null> =>
    ipcRenderer.invoke(IPC.media.get, mediaId),
  /** Delete a removed item's orphaned media-store files (cover art + tag sidecars).
   *  Stem/sample WAVs are deleted by the audio backend over the bridge, not here. */
  cleanupProjectFiles: (payload: { mediaIds: string[] }): Promise<boolean> =>
    ipcRenderer.invoke(IPC.media.cleanup, payload),
  /** Pick a new cover image and copy it into the covers dir as a per-item override.
   *  Returns the stored basename + bytes, or `{ cancelled: true }`. */
  updateItemCover: (payload: {
    itemId: string
    previousCoverFile?: string
  }): Promise<
    { cancelled: true } | { cancelled: false; coverFile: string; data: ArrayBuffer; mimeType: string }
  > => ipcRenderer.invoke(IPC.media.updateCover, payload),
  /** Read a per-item override cover back by its basename, or null when absent. */
  getItemCover: (coverFile: string): Promise<{ data: ArrayBuffer; mimeType: string } | null> =>
    ipcRenderer.invoke(IPC.media.getCover, coverFile)
}as const

contextBridge.exposeInMainWorld('silverdaw', api)

export type SilverdawApi = typeof api
