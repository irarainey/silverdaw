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
      getLastProjectPath(): Promise<string | null>
      setLastProjectPath(value: string | null): void
      projectFileExists(path: string): Promise<boolean>
      chooseProjectOpen(): Promise<string | null>
      chooseProjectSaveAs(defaultName: string): Promise<string | null>
      prepareProjectOpen(filePath: string): Promise<boolean>
      readPeaksCacheFile(cachePath: string): Promise<ArrayBuffer | null>
      getStartupDebugEnabled(): Promise<boolean>
      getDebugEnabled(): Promise<boolean>
      setDebugEnabled(value: boolean): void
    }
  }
}

export {}
