/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

declare global {
  interface OpenedAudioFile {
    readonly filePath: string
    readonly fileName: string
    readonly data: ArrayBuffer
  }

  interface AudioMetadata {
    readonly title?: string
    readonly artist?: string
    readonly albumArtist?: string
    readonly album?: string
    readonly year?: number
    readonly genre?: readonly string[]
    readonly trackNumber?: number
    readonly trackTotal?: number
    readonly discNumber?: number
    readonly discTotal?: number
    readonly bpm?: number
    readonly key?: string
    readonly composer?: string
    readonly comment?: string
    readonly codec?: string
    readonly container?: string
    readonly bitrate?: number
    readonly lossless?: boolean
    readonly tagTypes?: readonly string[]
    readonly coverArtDataUrl?: string
  }

  interface UiPreferences {
    trackHeaderWidth: number
    libraryPanelHeight: number
  }

  interface Window {
    jackdaw: {
      menuAction(action: string): void
      openAudioFile(): Promise<OpenedAudioFile | null>
      openAudioFiles(): Promise<OpenedAudioFile[]>
      readAudioFile(filePath: string): Promise<OpenedAudioFile | null>
      readAudioMetadata(filePath: string): Promise<AudioMetadata | null>
      getPathForFile(file: File): string
      onMenuAction(handler: (action: string) => void): () => void
      getUiPreferences(): Promise<UiPreferences>
      setUiPreferences(partial: Partial<UiPreferences>): void
    }
  }
}

export {}
