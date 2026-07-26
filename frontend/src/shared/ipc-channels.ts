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
    openExternal: 'app:openExternal',
    sendDiagnostics: 'app:sendDiagnostics'
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
    setAudioOutput: 'prefs:setAudioOutput',
    getKeepAwakeByDevice: 'prefs:getKeepAwakeByDevice',
    setKeepAwakeForDevice: 'prefs:setKeepAwakeForDevice',
    getEnabledMidiInputs: 'prefs:getEnabledMidiInputs',
    setMidiInputEnabled: 'prefs:setMidiInputEnabled',
    getMidiDeckSelections: 'prefs:getMidiDeckSelections',
    setMidiDeckSelection: 'prefs:setMidiDeckSelection',
    getMidiDevicePreferences: 'prefs:getMidiDevicePreferences',
    setMidiDevicePreferences: 'prefs:setMidiDevicePreferences',
    getBrake: 'prefs:getBrake',
    setBrake: 'prefs:setBrake',
    getBackspin: 'prefs:getBackspin',
    setBackspin: 'prefs:setBackspin',
    getScratchRealism: 'prefs:getScratchRealism',
    setScratchRealism: 'prefs:setScratchRealism',
    getScratch: 'prefs:getScratch',
    setScratch: 'prefs:setScratch',
    getStems: 'prefs:getStems',
    setStems: 'prefs:setStems'
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
    listImportSources: 'project:listImportSources',
    prepareOpen: 'project:prepareOpen',
    prepareRecovery: 'project:prepareRecovery',
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
  backend: {
    status: 'backend:status',
    restart: 'backend:restart'
  },
  stems: {
    getModelState: 'stems:getModelState',
    getModelDir: 'stems:getModelDir',
    getModelInfo: 'stems:getModelInfo',
    getGpuStatus: 'stems:getGpuStatus',
    locateModel: 'stems:locateModel',
    ensureModel: 'stems:ensureModel',
    cancelModelDownload: 'stems:cancelModelDownload',
    modelDownloadProgress: 'stems:modelDownloadProgress',
    // Optional Mel-Band RoFormer "Vocal Quality Pack" (higher-quality vocals).
    getVocalPackState: 'stems:getVocalPackState',
    getVocalPackPath: 'stems:getVocalPackPath',
    ensureVocalPack: 'stems:ensureVocalPack',
    locateVocalPack: 'stems:locateVocalPack',
    cancelVocalPackDownload: 'stems:cancelVocalPackDownload',
    vocalPackDownloadProgress: 'stems:vocalPackDownloadProgress',
    // Optional 4-stem BS-RoFormer "Rhythm Quality Pack" (higher-quality drums/bass).
    getRhythmPackState: 'stems:getRhythmPackState',
    getRhythmPackPath: 'stems:getRhythmPackPath',
    ensureRhythmPack: 'stems:ensureRhythmPack',
    locateRhythmPack: 'stems:locateRhythmPack',
    cancelRhythmPackDownload: 'stems:cancelRhythmPackDownload',
    rhythmPackDownloadProgress: 'stems:rhythmPackDownloadProgress'
  },
  media: {
    save: 'media:save',
    get: 'media:get',
    cleanup: 'media:cleanup',
    updateCover: 'media:updateCover',
    getCover: 'media:getCover'
  },
  log: {
    appendBatch: 'log:append-batch'
  }
} as const

/**
 * Process-level health of the audio engine, pushed from main to the
 * renderer over `IPC.backend.status`. This is about the OS *process*
 * lifecycle only — actual engine readiness is determined by the renderer
 * from the WebSocket bridge (reconnect + `PROJECT_STATE`).
 *
 * - `restarting` — the backend exited unexpectedly (crash / OS sleep
 *   fault) or a restart was requested; main is respawning it.
 * - `recovered`  — a respawned backend has stayed up long enough to be
 *   considered stable again.
 * - `failed`     — main exhausted its respawn attempts and gave up; the
 *   renderer should stop waiting and surface a terminal recovery UI.
 */
export type BackendStatus = 'restarting' | 'recovered' | 'failed'
