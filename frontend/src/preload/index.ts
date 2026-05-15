// Preload script - runs in an isolated context with access to Node APIs.
// Expose only what the renderer needs via `contextBridge`.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

export interface OpenedAudioFile {
  filePath: string
  fileName: string
  /** Raw file bytes; the renderer decodes via Web Audio API. */
  data: ArrayBuffer
}

export interface UiPreferences {
  trackHeaderWidth: number
  libraryPanelHeight: number
}

const api = {
  appName: 'Jackdaw',
  version: '0.1.0',
  platform: process.platform,
  /** Send a menu action ID to the main process. */
  menuAction: (action: string): void => {
    ipcRenderer.send('menu:action', action)
  },
  /**
   * Show an OS open dialog for an audio file and return its raw bytes.
   * Resolves to `null` if the user cancels.
   */
  openAudioFile: (): Promise<OpenedAudioFile | null> => ipcRenderer.invoke('audio:open'),
  /**
   * Multi-file variant. Used by the library panel's Import button.
   * Returns an array of opened files (empty if the user cancels).
   */
  openAudioFiles: (): Promise<OpenedAudioFile[]> => ipcRenderer.invoke('audio:openMany'),
  /**
   * Read an audio file by absolute filesystem path. Used after an OS
   * drag-drop, where the path comes from `getPathForFile(file)`.
   * Resolves to `null` if the read fails.
   */
  readAudioFile: (filePath: string): Promise<OpenedAudioFile | null> =>
    ipcRenderer.invoke('audio:readFile', filePath),
  /**
   * Resolve an OS drag-dropped `File` to its absolute filesystem path.
   * Wraps Electron's `webUtils.getPathForFile` so the renderer can pass
   * the result to `readAudioFile`. Returns `''` if no path is available
   * (e.g. the drag came from inside the app rather than from the OS).
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  /**
   * Subscribe to menu actions forwarded from the main process so the renderer
   * can drive UI flows (e.g. "Add Track from File...").
   * Returns an unsubscribe function.
   */
  onMenuAction: (handler: (action: string) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, action: string): void => handler(action)
    ipcRenderer.on('menu:action', listener)
    return () => ipcRenderer.removeListener('menu:action', listener)
  },
  /**
   * Ask the main process to show a native dialog summarising the current
   * backend connection state. The renderer owns the live state in
   * `transportStore`, so it passes the boolean through.
   */
  showStatusDialog: (connected: boolean): void => {
    ipcRenderer.send('dialog:status', connected)
  },
  /**
   * Fetch the persisted UI preferences (panel sizes etc.) from the main
   * process. Window bounds are applied by main directly, so they're not
   * part of the renderer-visible payload.
   */
  getUiPreferences: (): Promise<UiPreferences> => ipcRenderer.invoke('prefs:getUi'),
  /**
   * Update one or more UI preference keys. The renderer calls this
   * (debounced) whenever the user resizes a panel; main persists the
   * change to disk.
   */
  setUiPreferences: (partial: Partial<UiPreferences>): void => {
    ipcRenderer.send('prefs:setUi', partial)
  }
} as const

contextBridge.exposeInMainWorld('jackdaw', api)

export type JackdawApi = typeof api
