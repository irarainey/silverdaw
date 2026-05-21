/// <reference types="vite/client" />

import type {
  AudioMetadata as SharedAudioMetadata,
  OpenedAudioFile as SharedOpenedAudioFile,
  UiPreferences as SharedUiPreferences
} from '@shared/types'

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

  interface Window {
    silverdaw: {
      menuAction(action: string): void
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
      setLastProjectPath(value: string): void
      projectFileExists(path: string): Promise<boolean>
      chooseProjectOpen(): Promise<string | null>
      chooseProjectSaveAs(defaultName: string): Promise<string | null>
      prepareProjectOpen(filePath: string): Promise<boolean>
      consumePendingOpenPath(): Promise<string | null>
      onOpenProjectFromPath(handler: (filePath: string) => void): () => void
      readPeaksCacheFile(cachePath: string): Promise<ArrayBuffer | null>
      getStartupDebugEnabled(): Promise<boolean>
      getDebugEnabled(): Promise<boolean>
      setDebugEnabled(value: boolean): void
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
      getRecentProjects(): Promise<string[]>
      removeRecentProject(filePath: string): void
      clearRecentProjects(): void
      // ── Autosave configuration ────────────────────────────────────────
      getAutosaveConfig(): Promise<{ enabled: boolean; intervalSeconds: number }>
      setAutosaveConfig(partial: { enabled?: boolean; intervalSeconds?: number }): void
      getAudioOutput(): Promise<{ typeName: string | null; deviceName: string | null }>
      setAudioOutput(partial: { typeName: string | null; deviceName: string | null }): void
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
    }
  }
}

export {}
