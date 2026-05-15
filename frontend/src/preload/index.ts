// Preload script - runs in an isolated context with access to Node APIs.
// Expose only what the renderer needs via `contextBridge`.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AudioMetadata, OpenedAudioFile, UiPreferences } from '../shared/types'

export type { AudioMetadata, OpenedAudioFile, UiPreferences }

const api = {
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
   *
   * Main rejects any path it has not previously surfaced to the renderer
   * via an open-dialog result or via `getPathForFile` — see the path
   * allow-list in `frontend/src/main/index.ts`.
   */
  readAudioFile: (filePath: string): Promise<OpenedAudioFile | null> =>
    ipcRenderer.invoke('audio:readFile', filePath),
  /**
   * Read ID3 / Vorbis / iTunes / BWF metadata from an audio file. Returns
   * a normalized subset of fields the renderer can display. Resolves to
   * `null` if the file can't be parsed (the library entry still works
   * with just the Web Audio technical info).
   *
   * Same allow-list rules as `readAudioFile` apply.
   */
  readAudioMetadata: (filePath: string): Promise<AudioMetadata | null> =>
    ipcRenderer.invoke('audio:readMetadata', filePath),
  /**
   * Resolve an OS drag-dropped `File` to its absolute filesystem path.
   * Wraps Electron's `webUtils.getPathForFile` so the renderer can pass
   * the result to `readAudioFile`. Returns `''` if no path is available
   * (e.g. the drag came from inside the app rather than from the OS).
   *
   * The path is also registered with the main process so subsequent
   * `readAudioFile` / `readAudioMetadata` calls will accept it.
   */
  getPathForFile: (file: File): string => {
    try {
      const filePath = webUtils.getPathForFile(file)
      if (filePath !== '') {
        // Fire-and-forget: main side-effects the allow-list. If main hasn't
        // registered the path by the time the renderer calls `readAudioFile`
        // the read simply fails — the user can re-drop.
        ipcRenderer.send('audio:registerDroppedPath', filePath)
      }
      return filePath
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
  },
  /**
   * Resolve the WebSocket port the JUCE backend is listening on. The
   * value is chosen by main at startup (env override + default) and the
   * backend is launched with `--port <N>`, so all three processes agree
   * on a single source of truth.
   */
  getBridgePort: (): Promise<number> => ipcRenderer.invoke('bridge:getPort'),
  /**
   * Transcode decoded PCM into a temp WAV the JUCE backend can read.
   * Used for formats the backend can't decode natively (e.g. AAC/M4A on
   * Windows). `channels` is one Float32Array per channel, planar. The
   * returned path is owned by the main-process temp cache and is safe
   * to send to the backend via `CLIP_ADD`. Returns `null` on failure.
   */
  writeTempWav: (args: {
    sourcePath: string
    channels: Float32Array[]
    sampleRate: number
  }): Promise<string | null> => ipcRenderer.invoke('audio:writeTempWav', args)
} as const

contextBridge.exposeInMainWorld('jackdaw', api)

export type JackdawApi = typeof api
