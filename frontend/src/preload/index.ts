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
   * Show an OS audio-file picker and return ONLY the chosen path
   * (no bytes loaded). Used by the relink-missing-files flow: the
   * backend re-creates the clip's source against the picked path, so
   * the renderer never needs the bytes. Resolves to `null` if the
   * user cancels.
   */
  chooseAudioFile: (args: {
    title?: string
    defaultPath?: string
  }): Promise<string | null> => ipcRenderer.invoke('audio:chooseFile', args),
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
   * Resolve the per-session AUTH token the renderer must send as its
   * first WebSocket message. Generated once by main at startup and
   * passed to the spawned backend via the `SILVERDAW_BRIDGE_TOKEN` env
   * var; the backend closes any socket that doesn't AUTH correctly.
   * Returning the token over the trusted preload bridge keeps it out
   * of argv and out of the HTML.
   */
  getBridgeToken: (): Promise<string> => ipcRenderer.invoke('bridge:getToken'),
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
  }): Promise<string | null> => ipcRenderer.invoke('audio:writeTempWav', args),
  /**
   * Flush a batch of renderer-side log entries to the main-process
   * session log (`.logs/<stamp>/renderer.log`). Renderer-side logging
   * (`lib/log.ts`) buffers entries on a ~50 ms timer and calls this
   * once per flush so we avoid per-message IPC overhead.
   *
   * Each entry's `timestamp` is the renderer's `Date.now()` at the
   * point the log call was made — preserved across the IPC hop so the
   * persisted line reflects when the event actually happened, not
   * when it was flushed.
   */
  logBatch: (
    entries: ReadonlyArray<{ level: string; tag: string; message: string; timestamp: number }>
  ): Promise<void> => ipcRenderer.invoke('log:append-batch', entries),
  /**
   * Fetch static runtime info (app version, Electron / Chromium / Node
   * versions) for the in-app About dialog. Resolved once by main.
   */
  getAppInfo: (): Promise<{
    appVersion: string
    electron: string
    chromium: string
    node: string
  }> => ipcRenderer.invoke('app:getInfo'),
  /**
   * Open a URL in the user's default browser. Main vets the scheme
   * (only `https:` and `http:` are passed through) before handing it to
   * `shell.openExternal`.
   */
  openExternal: (url: string): void => {
    ipcRenderer.send('app:openExternal', url)
  },
  // ─── Project file lifecycle ──────────────────────────────────────────────
  /** Absolute path of the most recently saved/loaded project, or null. */
  getLastProjectPath: (): Promise<string | null> => ipcRenderer.invoke('project:getLastPath'),
  /** Persist the most recently saved/loaded project path (or null to clear). */
  setLastProjectPath: (value: string | null): void => {
    ipcRenderer.send('project:setLastPath', value)
  },
  /** Resolve to true iff `path` exists and is readable. */
  projectFileExists: (path: string): Promise<boolean> =>
    ipcRenderer.invoke('project:fileExists', path),
  /** Show the OS open dialog; resolves to the chosen path or null on cancel. */
  chooseProjectOpen: (): Promise<string | null> => ipcRenderer.invoke('project:chooseOpen'),
  /** Show the OS save-as dialog; `defaultName` seeds the suggested filename. */
  chooseProjectSaveAs: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('project:chooseSaveAs', defaultName),
  /**
   * Tell main that a `.silverdaw` file is about to be loaded. Main reads
   * the project XML and pre-registers every referenced audio path in
   * its `audio:readFile` / `audio:readMetadata` allow-list so the
   * renderer can refresh cover art on the library cards after load
   * without each path being rejected as untrusted.
   */
  prepareProjectOpen: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('project:prepareOpen', filePath),
  /**
   * On startup, ask main whether the user launched Silverdaw by
   * double-clicking a `.silverdaw` file in Explorer. Resolves to the
   * absolute path, or `null` if the app was launched normally. Main
   * clears the slot after returning so a renderer reload won't re-open
   * the same project.
   */
  consumePendingOpenPath: (): Promise<string | null> =>
    ipcRenderer.invoke('project:consumePendingOpenPath'),
  /**
   * Subscribe to "open this project" pushes from main, fired when a
   * second `Silverdaw.exe <file.silverdaw>` invocation is collapsed
   * into the running instance by the single-instance lock.
   * Returns an unsubscribe function.
   */
  onOpenProjectFromPath: (handler: (filePath: string) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, filePath: string): void => handler(filePath)
    ipcRenderer.on('project:openFromPath', listener)
    return () => ipcRenderer.removeListener('project:openFromPath', listener)
  },
  /**
   * Read a peaks-cache file (`<APPDATA>/Silverdaw/peaks/<hash>.peaks`)
   * by absolute path. Resolves to the raw bytes or null if the path is
   * outside the cache directory or unreadable. Used by the renderer's
   * `WAVEFORM_READY` handler — peaks bytes never cross the WebSocket.
   */
  readPeaksCacheFile: (cachePath: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('peaks:readCacheFile', cachePath),
  // ─── Debug toggle ──────────────────────────────────────────────────────
  /**
   * Resolve the debug flag sampled at startup. This is the value that
   * gates the Debug menu and the cross-layer file logger for the
   * lifetime of the current process — toggling the preference in the
   * Preferences dialog only takes effect on the NEXT launch.
   */
  getStartupDebugEnabled: (): Promise<boolean> => ipcRenderer.invoke('debug:getStartupEnabled'),
  /** Read the currently-saved debug flag (may differ from the startup snapshot). */
  getDebugEnabled: (): Promise<boolean> => ipcRenderer.invoke('debug:getEnabled'),
  /** Persist a new debug flag value. Takes effect on the next launch. */
  setDebugEnabled: (value: boolean): void => {
    ipcRenderer.send('debug:setEnabled', value)
  },
  // ─── Quality-of-life preferences ───────────────────────────────────────
  /**
   * Fetch the current QoL preferences (toast visibility + default
   * project / clip directories). Returned shape mirrors the on-disk
   * sub-trees: `{ toasts: { enabled }, paths: { defaultProjectDir, defaultClipDir } }`.
   */
  getQolPrefs: (): Promise<{
    toasts: { enabled: boolean }
    paths: { defaultProjectDir: string; defaultClipDir: string }
  }> => ipcRenderer.invoke('prefs:getQol'),
  /**
   * Persist one or more QoL preferences. Pass any subset of the keys
   * shown above; absent keys are left unchanged. Changes are written
   * back to `preferences.json` (debounced) and take effect immediately —
   * unlike the debug flag, none of the QoL settings need a restart.
   */
  setQolPrefs: (partial: {
    toasts?: { enabled?: boolean }
    paths?: { defaultProjectDir?: string; defaultClipDir?: string }
  }): void => {
    ipcRenderer.send('prefs:setQol', partial)
  },
  /**
   * Show an OS folder-picker dialog. Returns the absolute path the user
   * picked, or `null` if they cancelled. Used by the Preferences dialog
   * "Change…" buttons next to each path field.
   */
  chooseDirectory: (args: {
    title?: string
    defaultPath?: string
  }): Promise<string | null> => ipcRenderer.invoke('prefs:chooseDirectory', args)
}as const

contextBridge.exposeInMainWorld('silverdaw', api)

export type SilverdawApi = typeof api
