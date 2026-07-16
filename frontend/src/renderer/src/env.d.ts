/// <reference types="vite/client" />

import type {
  AudioMetadata as SharedAudioMetadata,
  DebugPreferences as SharedDebugPreferences,
  OpenedAudioFile as SharedOpenedAudioFile,
  UiPreferences as SharedUiPreferences,
  EnsureStemModelResult as SharedEnsureStemModelResult,
  StemModelDownloadProgress as SharedStemModelDownloadProgress,
  StemModelState as SharedStemModelState,
  StemModelInfo as SharedStemModelInfo,
  StemGpuStatus as SharedStemGpuStatus,
  StemPrefsDto as SharedStemPrefsDto,
  BrakePrefsDto as SharedBrakePrefsDto,
  BackspinPrefsDto as SharedBackspinPrefsDto,
  ScratchRealismPrefsDto as SharedScratchRealismPrefsDto,
  ScratchPrefsDto as SharedScratchPrefsDto,
  LocateStemModelResult as SharedLocateStemModelResult,
  RecentProject as SharedRecentProject
} from '@shared/types'
import type { BackendStatus } from '@shared/ipc-channels'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

declare global {
  // Re-exported from `frontend/src/shared/types.ts` as ambient globals so
  // renderer code can keep using the bare names without an import. The
  // single source of truth lives in the shared module — preload and main
  // import the same types directly.
  type OpenedAudioFile = SharedOpenedAudioFile
  type AudioMetadata = SharedAudioMetadata
  type UiPreferences = SharedUiPreferences
  type DebugPreferences = SharedDebugPreferences

  interface Window {
    silverdaw: {
      menuAction(action: string): void
      minimizeWindow(): void
      toggleMaximizeWindow(): void
      closeWindow(): void
      openAudioFile(): Promise<OpenedAudioFile | null>
      openAudioFiles(): Promise<OpenedAudioFile[]>
      chooseAudioFile(args: { title?: string; defaultPath?: string }): Promise<string | null>
      readAudioFile(filePath: string): Promise<OpenedAudioFile | null>
      readAudioMetadata(filePath: string): Promise<AudioMetadata | null>
      getPathForFile(file: File): string
      onMenuAction(handler: (action: string) => void): () => void
      getUiPreferences(): Promise<UiPreferences>
      setUiPreferences(partial: Partial<UiPreferences>): void
      getBridgePort(): Promise<number>
      getBridgeToken(): Promise<string>
      restartBackend(reason: string): Promise<void>
      onBackendStatus(handler: (status: BackendStatus) => void): () => void
      writeTempWav(args: {
        sourcePath: string
        channels: Float32Array[]
        sampleRate: number
      }): Promise<string | null>
      logBatch(
        entries: ReadonlyArray<{ level: string; tag: string; message: string; timestamp: number }>
      ): Promise<void>
      getAppInfo(): Promise<{
        appVersion: string
        electron: string
        chromium: string
        node: string
      }>
      openExternal(url: string): void
      sendDiagnostics(): Promise<boolean>
      setLastProjectPath(path: string, name: string): void
      projectFileExists(path: string): Promise<boolean>
      chooseProjectOpen(): Promise<string | null>
      chooseProjectSaveAs(defaultName: string): Promise<string | null>
      chooseMixdownSaveAs(defaultPath: string, format: 'wav' | 'mp3' | 'flac' | 'aiff'): Promise<string | null>
      resolveMixdownDefaultPath(projectFilePath: string | null, projectName: string, format: 'wav' | 'mp3' | 'flac' | 'aiff'): Promise<string>
      confirmMixdownOverwrite(filePath: string): Promise<'overwrite' | 'cancel' | 'not-found'>
      prepareProjectOpen(filePath: string): Promise<boolean>
      prepareProjectRecovery(autosavePath: string, originalPath: string | null): Promise<boolean>
      consumePendingOpenPath(): Promise<string | null>
      onOpenProjectFromPath(handler: (filePath: string) => void): () => void
      readPeaksCacheFile(cachePath: string): Promise<ArrayBuffer | null>
      getStartupDebugPreferences(): Promise<DebugPreferences>
      getDebugPreferences(): Promise<DebugPreferences>
      setDebugPreferences(partial: Partial<DebugPreferences>): void
      getQolPrefs(): Promise<{
        toasts: { enabled: boolean }
        paths: { defaultProjectDir: string; defaultClipDir: string }
      }>
      setQolPrefs(partial: {
        toasts?: { enabled?: boolean }
        paths?: { defaultProjectDir?: string; defaultClipDir?: string }
      }): void
      chooseDirectory(args: { title?: string; defaultPath?: string }): Promise<string | null>
      // ── Recent projects ───────────────────────────────────────────────
      getRecentProjects(): Promise<SharedRecentProject[]>
      removeRecentProject(filePath: string): void
      clearRecentProjects(): void
      // ── Autosave configuration ────────────────────────────────────────
      getAutosaveConfig(): Promise<{ enabled: boolean; intervalSeconds: number }>
      setAutosaveConfig(partial: { enabled?: boolean; intervalSeconds?: number }): void
      getAudioOutput(): Promise<{ typeName: string | null; deviceName: string | null }>
      setAudioOutput(partial: { typeName: string | null; deviceName: string | null }): void
      getKeepAwakeByDevice(): Promise<Record<string, boolean>>
      setKeepAwakeForDevice(deviceName: string, enabled: boolean): void
      getEnabledMidiInputs(): Promise<Record<string, boolean>>
      setMidiInputEnabled(identifier: string, enabled: boolean): void
      getMidiDeckSelections(): Promise<
        Record<string, { deck1Enabled: boolean; deck2Enabled: boolean }>
      >
      setMidiDeckSelection(
        identifier: string,
        selection: { deck1Enabled: boolean; deck2Enabled: boolean }
      ): void
      getMidiDevicePreferences(): Promise<
        Record<
          string,
          {
            scrubAudioEnabled: boolean
            crossfaderDirection: 'leftToRight' | 'rightToLeft'
            defaultDeck: 'none' | 'deck1' | 'deck2'
          }
        >
      >
      setMidiDevicePreferences(
        identifier: string,
        preferences: {
          scrubAudioEnabled: boolean
          crossfaderDirection: 'leftToRight' | 'rightToLeft'
          defaultDeck: 'none' | 'deck1' | 'deck2'
        }
      ): void
      // ── Autosave folder + manifest IPCs ───────────────────────────────
      resolveAutosaveDir(projectId: string): Promise<{ dir: string; filePath: string } | null>
      writeAutosaveManifest(manifest: {
        projectId: string
        originalPath: string | null
        projectName: string
        savedAtIso: string
        pending: boolean
      }): Promise<boolean>
      listRecoverableAutosaves(): Promise<
        Array<{
          projectId: string
          originalPath: string | null
          projectName: string
          autosavePath: string
          savedAtIso: string
          originalExists: boolean
        }>
      >
      clearAutosave(projectId: string): Promise<boolean>
      // ── Stem-separation model store ───────────────────────────────────
      getStemModelState(): Promise<SharedStemModelState>
      getStemModelDir(): Promise<string>
      getStemModelInfo(): Promise<SharedStemModelInfo>
      getStemGpuStatus(): Promise<SharedStemGpuStatus>
      locateStemModel(dir: string): Promise<SharedLocateStemModelResult>
      getStemPrefs(): Promise<SharedStemPrefsDto>
      setStemPrefs(partial: Partial<SharedStemPrefsDto>): Promise<void>
      getBrakeSettings(): Promise<SharedBrakePrefsDto>
      setBrakeSettings(partial: Partial<SharedBrakePrefsDto>): void
      getBackspinSettings(): Promise<SharedBackspinPrefsDto>
      setBackspinSettings(partial: Partial<SharedBackspinPrefsDto>): void
      getScratchRealismSettings(): Promise<SharedScratchRealismPrefsDto>
      setScratchRealismSettings(partial: Partial<SharedScratchRealismPrefsDto>): void
      getScratchSettings(): Promise<SharedScratchPrefsDto>
      setScratchSettings(partial: Partial<SharedScratchPrefsDto>): void
      ensureStemModel(): Promise<SharedEnsureStemModelResult>
      cancelStemModelDownload(): void
      onStemModelDownloadProgress(
        handler: (progress: SharedStemModelDownloadProgress) => void
      ): () => void
      getVocalPackState(): Promise<SharedStemModelState>
      getVocalPackPath(): Promise<string>
      ensureVocalPack(): Promise<SharedEnsureStemModelResult>
      locateVocalPack(dir: string): Promise<SharedLocateStemModelResult>
      cancelVocalPackDownload(): void
      onVocalPackDownloadProgress(
        handler: (progress: SharedStemModelDownloadProgress) => void
      ): () => void
      getRhythmPackState(): Promise<SharedStemModelState>
      getRhythmPackPath(): Promise<string>
      ensureRhythmPack(): Promise<SharedEnsureStemModelResult>
      locateRhythmPack(dir: string): Promise<SharedLocateStemModelResult>
      cancelRhythmPackDownload(): void
      onRhythmPackDownloadProgress(
        handler: (progress: SharedStemModelDownloadProgress) => void
      ): () => void
      saveProjectMedia(mediaId: string, sourceFilePath: string): Promise<boolean>
      getProjectMedia(mediaId: string): Promise<AudioMetadata | null>
      cleanupProjectFiles(payload: { mediaIds: string[] }): Promise<boolean>
      updateItemCover(payload: {
        itemId: string
        previousCoverFile?: string
      }): Promise<
        | { cancelled: true }
        | { cancelled: false; coverFile: string; data: ArrayBuffer; mimeType: string }
      >
      getItemCover(coverFile: string): Promise<{ data: ArrayBuffer; mimeType: string } | null>
    }
  }
}

export {}
