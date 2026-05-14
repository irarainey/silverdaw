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

  interface Window {
    jackdaw: {
      readonly appName: string
      readonly version: string
      readonly platform: NodeJS.Platform
      menuAction(action: string): void
      openAudioFile(): Promise<OpenedAudioFile | null>
      onMenuAction(handler: (action: string) => void): () => void
    }
  }
}

export {}
