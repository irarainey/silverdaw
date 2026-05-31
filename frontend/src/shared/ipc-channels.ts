/**
 * Single source of truth for Electron IPC channel names.
 *
 * The main process (`ipcMain.handle` / `ipcMain.on` / `webContents.send`)
 * and the preload bridge (`ipcRenderer.invoke` / `send` / `on`) used to
 * repeat these channel strings as bare literals on both ends — a drift
 * hazard where a rename or typo on one side silently breaks IPC at
 * runtime. Reference these constants from both ends so a mismatch
 * becomes a compile error instead.
 *
 * Grouped by domain; the leaf string is the wire channel name.
 */
export const IPC = {
  menu: {
    action: 'menu:action'
  },
  window: {
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggleMaximize',
    close: 'window:close'
  },
  app: {
    getInfo: 'app:getInfo',
    openExternal: 'app:openExternal'
  },
  bridge: {
    getPort: 'bridge:getPort',
    getToken: 'bridge:getToken'
  },
  audio: {
    open: 'audio:open',
    openMany: 'audio:openMany',
    chooseFile: 'audio:chooseFile',
    readFile: 'audio:readFile',
    readMetadata: 'audio:readMetadata',
    registerDroppedPath: 'audio:registerDroppedPath',
    writeTempWav: 'audio:writeTempWav'
  },
  prefs: {
    getUi: 'prefs:getUi',
    setUi: 'prefs:setUi',
    getQol: 'prefs:getQol',
    setQol: 'prefs:setQol',
    chooseDirectory: 'prefs:chooseDirectory',
    getRecentProjects: 'prefs:getRecentProjects',
    removeRecentProject: 'prefs:removeRecentProject',
    clearRecentProjects: 'prefs:clearRecentProjects',
    getAutosaveConfig: 'prefs:getAutosaveConfig',
    setAutosaveConfig: 'prefs:setAutosaveConfig',
    getAudioOutput: 'prefs:getAudioOutput',
    setAudioOutput: 'prefs:setAudioOutput'
  },
  debug: {
    getStartupPrefs: 'debug:getStartupPrefs',
    getPrefs: 'debug:getPrefs',
    setPrefs: 'debug:setPrefs'
  },
  project: {
    setLastPath: 'project:setLastPath',
    fileExists: 'project:fileExists',
    chooseOpen: 'project:chooseOpen',
    chooseSaveAs: 'project:chooseSaveAs',
    prepareOpen: 'project:prepareOpen',
    consumePendingOpenPath: 'project:consumePendingOpenPath',
    openFromPath: 'project:openFromPath'
  },
  mixdown: {
    chooseSaveAs: 'mixdown:chooseSaveAs',
    resolveDefaultPath: 'mixdown:resolveDefaultPath',
    confirmOverwrite: 'mixdown:confirmOverwrite'
  },
  autosave: {
    resolveDir: 'autosave:resolveDir',
    writeManifest: 'autosave:writeManifest',
    listRecoverable: 'autosave:listRecoverable',
    clear: 'autosave:clear'
  },
  peaks: {
    readCacheFile: 'peaks:readCacheFile'
  },
  log: {
    appendBatch: 'log:append-batch'
  }
} as const
