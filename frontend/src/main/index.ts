import { app, BrowserWindow, Menu, ipcMain, nativeTheme, dialog, shell, screen } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { basename, dirname, extname, isAbsolute, join, resolve as pathResolve } from 'node:path'
import { closeLogs, getSessionDir, initLogs, logMain, logRendererLine, type LogLevel } from './log'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { parseFile, type IAudioMetadata, type IPicture } from 'music-metadata'
import type { AudioMetadata } from '../shared/types'

// ─── Audio metadata ─────────────────────────────────────────────────────────
// `AudioMetadata` lives in `src/shared/types.ts` and is shared with preload +
// renderer. The helpers below take a `music-metadata` parse result and emit
// the normalised wire shape.

/** Drop embedded pictures larger than this so we don't bloat the Pinia store. */
const MAX_COVER_ART_BYTES = 2 * 1024 * 1024

/**
 * Pick the best cover-art picture (preferring an explicit front cover) and
 * return its raw bytes + MIME type. The renderer turns the buffer into a
 * `Blob` + `URL.createObjectURL`, so we ship binary across IPC rather than
 * base64-inflated data URLs.
 */
function pickCoverArt(
  pictures: IPicture[] | undefined
): { data: ArrayBuffer; mimeType: string } | undefined {
  if (!pictures || pictures.length === 0) return undefined
  // Prefer a front-cover-type picture if the tag distinguishes them; else first.
  const front = pictures.find((p) => (p.type ?? '').toLowerCase().includes('cover')) ?? pictures[0]
  if (!front.data || front.data.length === 0 || front.data.length > MAX_COVER_ART_BYTES) {
    return undefined
  }
  // Copy into a fresh ArrayBuffer so we hand IPC an owned, transferable
  // buffer rather than a view into the (potentially larger) parse-result
  // arena `music-metadata` keeps internally.
  const src = front.data
  const data = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer
  const mimeType = front.format || 'image/jpeg'
  return { data, mimeType }
}

function normalizeMetadata(meta: IAudioMetadata): AudioMetadata {
  const { common, format } = meta
  const out: AudioMetadata = {}
  if (common.title) out.title = common.title
  if (common.artist) out.artist = common.artist
  if (common.albumartist) out.albumArtist = common.albumartist
  if (common.album) out.album = common.album
  if (typeof common.year === 'number') out.year = common.year
  if (common.genre && common.genre.length > 0) out.genre = common.genre
  if (common.track) {
    if (typeof common.track.no === 'number') out.trackNumber = common.track.no
    if (typeof common.track.of === 'number') out.trackTotal = common.track.of
  }
  if (common.disk) {
    if (typeof common.disk.no === 'number') out.discNumber = common.disk.no
    if (typeof common.disk.of === 'number') out.discTotal = common.disk.of
  }
  if (typeof common.bpm === 'number') out.bpm = common.bpm
  if (common.key) out.key = common.key
  if (common.composer && common.composer.length > 0) out.composer = common.composer.join(', ')
  if (common.comment && common.comment.length > 0) {
    const first = common.comment[0]
    out.comment = typeof first === 'string' ? first : (first?.text ?? undefined)
  }
  if (format.codec) out.codec = format.codec
  if (format.container) out.container = format.container
  if (typeof format.bitrate === 'number') out.bitrate = format.bitrate
  if (typeof format.duration === 'number') out.durationMs = format.duration * 1000
  if (typeof format.sampleRate === 'number') out.sampleRate = format.sampleRate
  if (typeof format.numberOfChannels === 'number') out.channelCount = format.numberOfChannels
  if (typeof format.lossless === 'boolean') out.lossless = format.lossless
  if (format.tagTypes && format.tagTypes.length > 0) out.tagTypes = [...format.tagTypes]
  const cover = pickCoverArt(common.picture)
  if (cover) out.coverArt = cover
  return out
}

// ─── Theme / colours (kept in sync with the renderer Tailwind palette) ──────
const TITLE_BAR_HEIGHT = 36
const COLOUR_BG = '#18181b' // zinc-900
const COLOUR_FG = '#d4d4d8' // zinc-300

// File extensions accepted by every audio open-dialog and (later) by the
// path-validation guard on `audio:readFile` / `audio:readMetadata`. Keep in
// sync with the JUCE backend's supported formats.
const AUDIO_FILE_EXTENSIONS = ['wav', 'mp3', 'flac', 'aiff', 'aif', 'ogg', 'm4a'] as const
const AUDIO_FILE_EXTENSIONS_SET: ReadonlySet<string> = new Set<string>(AUDIO_FILE_EXTENSIONS)

/**
 * Whitelist of absolute filesystem paths the renderer is allowed to read via
 * `audio:readFile` / `audio:readMetadata`. Populated when main hands a path
 * to the renderer (open-dialog result) or when the renderer reports a path
 * obtained from an OS drag-drop via `webUtils.getPathForFile` through the
 * `audio:registerDroppedPath` IPC.
 *
 * Without this guard a compromised renderer could read any file the main
 * process can — see FE-004 in the security review.
 */
const issuedAudioPaths: Set<string> = new Set<string>()

/**
 * Filesystem cache for renderer-side transcodes. The renderer decodes
 * lossy / non-native formats (e.g. .m4a) via the Web Audio API and asks
 * main to dump the PCM as a WAV; the backend then reads that WAV. Files
 * are keyed by a hash of the source path + decoded geometry so the same
 * import doesn't re-transcode on every clip placement.
 */
const TRANSCODE_CACHE_DIR = join(tmpdir(), 'silverdaw-transcode-cache')

/** Normalise to an absolute path so allow-list membership is canonical. */
function canonicalisePath(p: string): string {
  return pathResolve(p)
}

/**
 * Add a path to the allow-list using its canonical absolute form. Rejects
 * anything that isn't an absolute path with an accepted audio extension,
 * so a future regression that leaks `ipcRenderer.send` to a compromised
 * renderer can't pollute the read allow-list with arbitrary filesystem
 * locations. (FE-004 in the security review.)
 */
function registerIssuedPath(filePath: string): void {
  if (typeof filePath !== 'string' || filePath === '') return
  if (!isAbsolute(filePath)) {
    console.warn('[main] refusing to register non-absolute path:', filePath)
    return
  }
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!AUDIO_FILE_EXTENSIONS_SET.has(ext)) {
    console.warn('[main] refusing to register non-audio path:', filePath)
    return
  }
  issuedAudioPaths.add(canonicalisePath(filePath))
}

/**
 * True if `filePath` is on the allow-list AND has an accepted audio
 * extension. The extension check is belt-and-braces: every path that
 * makes it onto the allow-list has already passed the dialog filter or
 * a drag-drop from the OS, but defence-in-depth is cheap here.
 */
function isAllowedAudioPath(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string' || filePath === '') return false
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!AUDIO_FILE_EXTENSIONS_SET.has(ext)) return false
  return issuedAudioPaths.has(canonicalisePath(filePath))
}

let backendProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null
/**
 * Set to true once the renderer has confirmed (after running its
 * unsaved-changes guard) that the window can close. The `close` event
 * handler intercepts the first attempt and waits for this flag.
 */
let userConfirmedClose = false

// ─── Backend bridge port ────────────────────────────────────────────────────
// The JUCE backend listens on `ws://127.0.0.1:<bridgePort>`. The port is
// resolvable via `SILVERDAW_BRIDGE_PORT` so multiple Silverdaw instances (or a
// stand-alone backend used for debugging) can avoid colliding on 8765.
// Main passes the same value to the backend via `--port` AND exposes it to
// the renderer through `bridge:getPort`, so all three processes agree on
// one canonical source of truth.
const DEFAULT_BRIDGE_PORT = 8765
const MIN_BRIDGE_PORT = 1024
const MAX_BRIDGE_PORT = 65535

function resolveBridgePort(): number {
  const raw = process.env['SILVERDAW_BRIDGE_PORT']
  if (raw === undefined || raw === '') return DEFAULT_BRIDGE_PORT
  const parsed = Number.parseInt(raw, 10)
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_BRIDGE_PORT ||
    parsed > MAX_BRIDGE_PORT
  ) {
    console.warn(
      `[main] SILVERDAW_BRIDGE_PORT=${raw} is not a valid port in [${MIN_BRIDGE_PORT}, ${MAX_BRIDGE_PORT}]; using default ${DEFAULT_BRIDGE_PORT}`
    )
    return DEFAULT_BRIDGE_PORT
  }
  return parsed
}

let bridgePort = resolveBridgePort()
const bridgePortEnvOverridden =
  typeof process.env['SILVERDAW_BRIDGE_PORT'] === 'string' &&
  process.env['SILVERDAW_BRIDGE_PORT']!.length > 0

/**
 * Probe whether `port` on `127.0.0.1` is free for a fresh TCP listener.
 * Uses a short-lived `net.Server` rather than scraping `netstat` output
 * — it works regardless of platform locale and gives a definitive
 * answer (any error code from `listen()` means "not free").
 *
 * The server is closed immediately on success; there's a tiny race
 * window before the backend itself binds, but loopback ports on Windows
 * recycle fast enough that this is reliable in practice. Worst case
 * the backend's own bind fails and the renderer surfaces the bridge
 * timeout error.
 */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Find the first free port in `[start, start + count)`. Stops as soon
 * as one binds. Returns `null` if every port in the range is taken —
 * which only realistically happens if there are many zombie Silverdaw
 * processes or another app is occupying the entire scan window.
 */
async function findFreeBridgePort(start: number, count: number): Promise<number | null> {
  for (let i = 0; i < count; i++) {
    const candidate = start + i
    if (candidate > MAX_BRIDGE_PORT) break
    if (await isPortFree(candidate)) return candidate
  }
  return null
}

// ─── Backend bridge AUTH token ──────────────────────────────────────────────
// Loopback alone is not a strong trust boundary — any other process running
// as the same user can connect to the WebSocket. Each backend launch gets a
// fresh 256-bit random token; main passes it to the backend via the
// `SILVERDAW_BRIDGE_TOKEN` env var (NOT a CLI arg — argv is visible in the OS
// process table) and exposes it to the renderer through `bridge:getToken`,
// so the renderer can send it as the first WebSocket message. The backend
// closes any socket that fails to AUTH on its first envelope.
const bridgeToken = randomBytes(32).toString('hex')

// ─── Persisted preferences (window state + UI panel sizes) ──────────────────
// Stored as JSON in `<userData>/preferences.json`. Writes are debounced so a
// burst of resize/move events doesn't hammer the disk; an unconditional
// flush runs on `before-quit` to make sure the final state is captured.

interface WindowPrefs {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface UiPrefs {
  trackHeaderWidth: number
  libraryPanelHeight: number
  /** When true, the timeline scrolls during playback so the playhead
   *  stays pinned near the centre of the viewport. When false, the
   *  view stays still and the playhead can run off the right edge. */
  followPlayback: boolean
  /** When true, library tiles include cover art or a fallback icon. */
  showLibraryTileImages: boolean
}

/**
 * Developer / diagnostic preferences. `enabled` gates the entire cross-layer
 * file logger (backend.log + main.log + renderer.log) AND the visibility of
 * the Debug menu (Toggle Developer Tools, etc.). The value is sampled once
 * at startup and persists for the lifetime of the process; toggling it via
 * Preferences takes effect on the NEXT launch (mirroring how a release-mode
 * build is typically distinguished from a debug-mode one).
 */
interface DebugPrefs {
  enabled: boolean
}

/** Toast-notification visibility. `enabled=false` silences every toast
 *  the renderer would otherwise pop — the underlying event is still
 *  written to the log when debug mode is on, so nothing is lost. */
interface ToastPrefs {
  enabled: boolean
}

/**
 * Persisted default directories for OS open / save dialogs.
 *
 *   - `defaultProjectDir` is the directory the project Open / Save As
 *     dialogs land in **every time**. The user explicitly asked for the
 *     pref to win over any per-session "last opened" tracking so files
 *     stay in one predictable place.
 *
 *   - `defaultClipDir` is the directory the audio-file open dialogs land
 *     in on the **first** open of each session. After the user picks a
 *     file, the in-memory `currentClipDir` slot is updated to that
 *     file's directory so subsequent opens follow the user's browse —
 *     but on next launch we reset back to this pref.
 *
 * Both paths are validated cheaply on use (`mkdir -p` for the project
 * dir; falls back to home dir if either string is empty). They never
 * affect the path-allow-list applied to `audio:readFile` etc. — that
 * remains driven solely by paths the user picked through a vetted
 * channel.
 */
interface PathPrefs {
  defaultProjectDir: string
  defaultClipDir: string
}

/**
 * Background autosave configuration. While the project is dirty AND
 * `enabled` is true, the renderer runs a periodic timer that pushes a
 * `PROJECT_AUTOSAVE` to a project-scoped folder under
 * `%APPDATA%/Silverdaw/autosave/<projectId>/`. A clean shutdown — File >
 * Save, accepting "Discard" in the unsaved-changes dialog, or any other
 * path that resolves dirty — clears the bucket. The periodic save is
 * deliberately the only crash-recovery mechanism (a synchronous flush
 * during `before-quit` could race the IXWebSocket I/O loop and would
 * not be reliable enough to be worth implementing).
 */
interface AutosavePrefs {
  enabled: boolean
  /** Tick interval in seconds. Clamped 5..600 on read so a corrupted
   *  preferences file can never DoS the bridge with sub-second saves. */
  intervalSeconds: number
}

/**
 * Persisted audio output device selection. Both fields null = "use
 * system default". When non-null, main passes them to the backend via
 * `SILVERDAW_OUTPUT_DEVICE_TYPE` / `SILVERDAW_OUTPUT_DEVICE_NAME` env
 * vars at spawn time; if the device isn't available on this machine
 * (e.g. USB headphones unplugged before launch) the backend silently
 * falls back to default and tells the renderer via the
 * `fellBackToDefault` flag on `AUDIO_DEVICES_LIST` — the persisted
 * preference is kept intact, so re-plugging the device next launch
 * just works.
 */
interface AudioOutputPrefs {
  typeName: string | null
  deviceName: string | null
}

interface Preferences {
  window: WindowPrefs
  ui: UiPrefs
  debug: DebugPrefs
  toasts: ToastPrefs
  paths: PathPrefs
  autosave: AutosavePrefs
  audioOutput: AudioOutputPrefs
  /**
   * Most-recently used `.silverdaw` paths, head = most recent. Capped
   * at `MAX_RECENT_PROJECTS`; deduplicated case-insensitively on
   * Windows. Populated by `project:setLastPath` on every successful
   * save/load. The head of this list also acts as the "last
   * project" the app would auto-reopen if that flow ever lands.
   */
  recentProjects: string[]
}

const MAX_RECENT_PROJECTS = 10
const AUTOSAVE_MIN_SECONDS = 5
const AUTOSAVE_MAX_SECONDS = 600
const AUTOSAVE_DEFAULT_SECONDS = 30

/**
 * Build the default preferences object. The path defaults need
 * `app.getPath` (only available after `app.whenReady`) so we resolve
 * them lazily the first time we need them rather than at module load.
 */
function buildDefaultPrefs(): Preferences {
  const home = app.getPath('home')
  // Default to <Music>/Silverdaw so projects live alongside the audio
  // files most users will be importing from. Falls back to <home>/Silverdaw
  // if the OS can't resolve a Music folder (e.g. headless / sandboxed env).
  let musicDir = ''
  try {
    musicDir = app.getPath('music')
  } catch {
    musicDir = ''
  }
  const defaultProjectDir = musicDir ? join(musicDir, 'Silverdaw') : join(home, 'Silverdaw')
  // Clip dialogs land in the OS Music folder by default; if that's not
  // available we fall back to the project folder so a fresh install never
  // points at a non-existent path.
  const defaultClipDir = musicDir || defaultProjectDir
  return {
    window: { width: 1400, height: 900, maximized: false },
    ui: {
      trackHeaderWidth: 175,
      libraryPanelHeight: 180,
      followPlayback: true,
      showLibraryTileImages: true
    },
    debug: { enabled: false },
    toasts: { enabled: true },
    paths: { defaultProjectDir, defaultClipDir },
    autosave: { enabled: true, intervalSeconds: AUTOSAVE_DEFAULT_SECONDS },
    audioOutput: { typeName: null, deviceName: null },
    recentProjects: []
  }
}

let prefs: Preferences = {
  window: { width: 1400, height: 900, maximized: false },
  ui: {
    trackHeaderWidth: 175,
    libraryPanelHeight: 180,
    followPlayback: true,
    showLibraryTileImages: true
  },
  debug: { enabled: false },
  toasts: { enabled: true },
  paths: { defaultProjectDir: '', defaultClipDir: '' },
  autosave: { enabled: true, intervalSeconds: AUTOSAVE_DEFAULT_SECONDS },
  audioOutput: { typeName: null, deviceName: null },
  recentProjects: []
}
let prefsPath = ''
let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Working clip directory for the current session. Initialised from
 * `prefs.paths.defaultClipDir` once `app.whenReady` has resolved, then
 * updated to the directory of whichever clip the user most recently
 * picked. NOT persisted — each launch starts at the configured default.
 */
let currentClipDir = ''

/**
 * Snapshot of `prefs.debug.enabled` sampled once at startup, AFTER
 * `loadPreferences()` runs. The Debug menu visibility, the cross-layer
 * file logger, and the `SILVERDAW_LOG_DIR` env var passed to the JUCE
 * backend are all gated on this constant — toggling Preferences during
 * the session only updates the saved value and takes effect on the
 * next launch.
 */
let startupDebugEnabled = false

function getPrefsPath(): string {
  if (!prefsPath) prefsPath = join(app.getPath('userData'), 'preferences.json')
  return prefsPath
}

/** Update the in-memory `currentClipDir` to the parent folder of
 *  `pickedFile`. Called after every audio open-dialog success so the
 *  next dialog opens where the user just was. */
function rememberClipDir(pickedFile: string): void {
  if (!pickedFile) return
  const dir = dirname(pickedFile)
  if (dir && dir !== currentClipDir) currentClipDir = dir
}

async function loadPreferences(): Promise<void> {
  const defaults = buildDefaultPrefs()
  prefs = structuredClone(defaults)
  try {
    const raw = await readFile(getPrefsPath(), 'utf8')
    // Empty file = no prefs yet (e.g. atomic-write was interrupted, or a
    // brand-new install before the first save). Treat the same as ENOENT
    // so we don't spam stderr with a SyntaxError on every startup.
    if (raw.trim().length === 0) {
      seedSessionPaths()
      await ensureProjectDirExists()
      return
    }
    const parsed = JSON.parse(raw) as Partial<Preferences>
    // Merge over defaults so newly-added keys get sane values on first
    // run after an upgrade. Path strings fall back to the computed
    // defaults if the saved value is empty / non-string.
    const savedPaths = (parsed.paths ?? {}) as Partial<PathPrefs>
    prefs = {
      window: { ...defaults.window, ...(parsed.window ?? {}) },
      ui: { ...defaults.ui, ...(parsed.ui ?? {}) },
      debug: { ...defaults.debug, ...(parsed.debug ?? {}) },
      toasts: { ...defaults.toasts, ...(parsed.toasts ?? {}) },
      paths: {
        defaultProjectDir:
          typeof savedPaths.defaultProjectDir === 'string' && savedPaths.defaultProjectDir.length > 0
            ? savedPaths.defaultProjectDir
            : defaults.paths.defaultProjectDir,
        defaultClipDir:
          typeof savedPaths.defaultClipDir === 'string' && savedPaths.defaultClipDir.length > 0
            ? savedPaths.defaultClipDir
            : defaults.paths.defaultClipDir
      },
      autosave: {
        enabled:
          typeof (parsed.autosave as Partial<AutosavePrefs> | undefined)?.enabled === 'boolean'
            ? ((parsed.autosave as AutosavePrefs).enabled)
            : defaults.autosave.enabled,
        intervalSeconds: clampAutosaveSeconds(
          (parsed.autosave as Partial<AutosavePrefs> | undefined)?.intervalSeconds
        )
      },
      audioOutput: {
        typeName:
          typeof (parsed.audioOutput as Partial<AudioOutputPrefs> | undefined)?.typeName === 'string' &&
          (parsed.audioOutput as AudioOutputPrefs).typeName!.length > 0
            ? (parsed.audioOutput as AudioOutputPrefs).typeName
            : null,
        deviceName:
          typeof (parsed.audioOutput as Partial<AudioOutputPrefs> | undefined)?.deviceName === 'string' &&
          (parsed.audioOutput as AudioOutputPrefs).deviceName!.length > 0
            ? (parsed.audioOutput as AudioOutputPrefs).deviceName
            : null
      },
      recentProjects: sanitiseRecentList(parsed.recentProjects)
    }
  } catch (err) {
    // ENOENT on first run is expected; anything else is logged but we still
    // fall back to defaults rather than blocking startup.
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') {
      console.warn('[prefs] load failed, using defaults:', err)
    }
  }
  seedSessionPaths()
  await ensureProjectDirExists()
}

/** Initialise the in-memory `currentClipDir` from the persisted pref. */
function seedSessionPaths(): void {
  currentClipDir = prefs.paths.defaultClipDir || prefs.paths.defaultProjectDir
}

/** Create `paths.defaultProjectDir` if it doesn't yet exist so the
 *  project Save / Open dialogs always have a real directory to land in.
 *  Silent on failure — the dialog will just fall back to the user's
 *  home directory if Electron can't open the configured path. */
async function ensureProjectDirExists(): Promise<void> {
  const dir = prefs.paths.defaultProjectDir
  if (!dir) return
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    console.warn('[prefs] could not create default project dir', dir, err)
  }
}

function schedulePrefsSave(): void {
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer)
  prefsSaveTimer = setTimeout(() => {
    prefsSaveTimer = null
    void flushPrefsSave()
  }, 400)
}

async function flushPrefsSave(): Promise<void> {
  if (prefsSaveTimer) {
    clearTimeout(prefsSaveTimer)
    prefsSaveTimer = null
  }
  try {
    const path = getPrefsPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(prefs, null, 2), 'utf8')
  } catch (err) {
    console.warn('[prefs] save failed:', err)
  }
}

function flushPrefsSaveSync(): void {
  if (prefsSaveTimer) {
    clearTimeout(prefsSaveTimer)
    prefsSaveTimer = null
  }
  try {
    const path = getPrefsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf8')
  } catch (err) {
    console.warn('[prefs] save failed:', err)
  }
}

function clampAutosaveSeconds(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input) ? input : AUTOSAVE_DEFAULT_SECONDS
  if (value < AUTOSAVE_MIN_SECONDS) return AUTOSAVE_MIN_SECONDS
  if (value > AUTOSAVE_MAX_SECONDS) return AUTOSAVE_MAX_SECONDS
  return Math.round(value)
}

/** Sanitise an arbitrary value parsed out of `preferences.json` into a
 *  recent-project string list: trim, dedupe (Windows case-insensitive),
 *  drop empties, cap at MAX_RECENT_PROJECTS. */
function sanitiseRecentList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of input) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= MAX_RECENT_PROJECTS) break
  }
  return out
}

/** Insert `filePath` at the head of `prefs.recentProjects`, deduped
 *  case-insensitively, capped at MAX_RECENT_PROJECTS. Returns true when
 *  the list mutated so the caller can decide whether to write to disk. */
function bumpRecentProject(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  const key = filePath.toLowerCase()
  const existingIndex = prefs.recentProjects.findIndex((p) => p.toLowerCase() === key)
  if (existingIndex === 0) return false
  if (existingIndex > 0) prefs.recentProjects.splice(existingIndex, 1)
  prefs.recentProjects.unshift(filePath)
  if (prefs.recentProjects.length > MAX_RECENT_PROJECTS) {
    prefs.recentProjects.length = MAX_RECENT_PROJECTS
  }
  return true
}

// ─── Autosave folder layout ────────────────────────────────────────────
//
// All autosave artefacts live under `%APPDATA%/Silverdaw/autosave/`.
// Each project (saved or untitled) gets its own subfolder keyed by a
// renderer-supplied `projectId` containing `autosave.silverdaw` (the
// serialised ValueTree) + `manifest.json`. Recovery on launch is just
// a walk of these subfolders.
//
// The `projectId` is whitelisted to a strict character set before it
// touches the filesystem so a malicious renderer can't break out of
// the autosave folder via `../` segments or absolute paths. The same
// rule applies to deletes / listings.
const AUTOSAVE_FILENAME = 'autosave.silverdaw'
const AUTOSAVE_MANIFEST_FILENAME = 'manifest.json'
const AUTOSAVE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/

function getAutosaveRoot(): string {
  return join(app.getPath('userData'), 'autosave')
}

function resolveAutosaveDir(projectId: string): string {
  if (!AUTOSAVE_ID_REGEX.test(projectId)) {
    throw new Error(`[autosave] rejected projectId ${JSON.stringify(projectId)}`)
  }
  return join(getAutosaveRoot(), projectId)
}

interface AutosaveManifest {
  projectId: string
  originalPath: string | null
  projectName: string
  /** ISO-8601 UTC timestamp of the most recent confirmed autosave write. */
  savedAtIso: string
  /** True between the moment the renderer kicks off a tick and the
   *  PROJECT_AUTOSAVED ack. Recovery skips pending entries because
   *  the file may be partially written. */
  pending: boolean
  /** App version that wrote the autosave — surfaced in the recovery
   *  dialog for diagnostics. */
  appVersion: string
}

function isAutosaveManifest(value: unknown): value is AutosaveManifest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.projectId === 'string' &&
    AUTOSAVE_ID_REGEX.test(v.projectId) &&
    (v.originalPath === null || typeof v.originalPath === 'string') &&
    typeof v.projectName === 'string' &&
    typeof v.savedAtIso === 'string' &&
    typeof v.pending === 'boolean'
  )
}


/**
 * Return a window bounds object clamped to fall inside one of the currently
 * connected displays. Prevents the window from opening off-screen after a
 * monitor is unplugged.
 */
function resolveWindowBounds(): { x?: number; y?: number; width: number; height: number } {
  const w = prefs.window
  const width = Math.max(900, Math.min(8000, w.width))
  const height = Math.max(600, Math.min(8000, w.height))
  if (typeof w.x !== 'number' || typeof w.y !== 'number') {
    return { width, height }
  }
  // Confirm the saved top-left is on a connected display; if not, drop the
  // position and let Electron centre the window on the primary display.
  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const { x, y, width: dw, height: dh } = d.workArea
    return w.x! >= x && w.y! >= y && w.x! < x + dw && w.y! < y + dh
  })
  return onScreen ? { x: w.x, y: w.y, width, height } : { width, height }
}

function captureWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // Don't overwrite the saved x/y/width/height while the window is in a
  // maximized state — we want to restore the *unmaximized* bounds next time.
  const maximized = mainWindow.isMaximized()
  prefs.window.maximized = maximized
  if (!maximized) {
    // `getNormalBounds()` is symmetric with `setBounds()` — round-tripping
    // through it keeps the window from drifting bigger each session.
    // `getBounds()` on Windows with `titleBarStyle: 'hidden'` returns
    // values that, when fed back into the constructor or `setBounds`,
    // produce a slightly larger window — a few px of growth per restart.
    const b = mainWindow.getNormalBounds()
    prefs.window.x = b.x
    prefs.window.y = b.y
    prefs.window.width = b.width
    prefs.window.height = b.height
  }
  schedulePrefsSave()
}

function startBackend(): void {
  const exeName = process.platform === 'win32' ? 'SilverdawBackend.exe' : 'SilverdawBackend'

  // Two layouts to handle:
  //
  // 1. Dev (`pnpm dev`): `__dirname` is `<repo>/frontend/out/main/`, and the
  //    JUCE backend lives at
  //    `<repo>/backend/build/SilverdawBackend_artefacts/<Config>/SilverdawBackend.exe`.
  //    `SILVERDAW_BACKEND_CONFIG` lets you swap between Debug / Release.
  //
  // 2. Packaged installer: `electron-builder` copies the Release backend exe
  //    (declared as `extraResources` in `electron-builder.yml`) into
  //    `process.resourcesPath/backend/`. `app.isPackaged` is the canonical
  //    way to distinguish the two modes.
  let exePath: string
  if (app.isPackaged) {
    exePath = join(process.resourcesPath, 'backend', exeName)
  } else {
    const buildConfig = process.env['SILVERDAW_BACKEND_CONFIG'] ?? 'Debug'
    exePath = join(
      __dirname,
      '..',
      '..',
      '..',
      'backend',
      'build',
      'SilverdawBackend_artefacts',
      buildConfig,
      exeName
    )
  }

  backendProcess = spawn(exePath, ['--port', String(bridgePort)], {
    stdio: 'inherit',
    // Suppress the console window Windows would otherwise create for
    // any console-subsystem child (`juce_add_console_app` produces one).
    // In dev (`pnpm dev`) the backend's stdio still flows into the
    // parent terminal because it inherits the pipes; in a packaged
    // install the parent has no console, so there's nothing to lose.
    windowsHide: true,
    // Forward `SILVERDAW_BRIDGE_TOKEN` via the spawn env (NOT via argv —
    // command-line arguments are visible in the OS process table). The
    // backend's `resolveBridgeToken()` reads the same env var and
    // requires every WebSocket client to AUTH with this exact value.
    // `SILVERDAW_LOG_DIR` is exported so the C++ logger writes its
    // `backend.log` into the same per-session folder as `main.log` and
    // `renderer.log`. Only exported when debug logging is on; an empty
    // env var would cause the backend to silently skip logger init.
    env: {
      ...process.env,
      SILVERDAW_BRIDGE_TOKEN: bridgeToken,
      // Pass the persisted audio-output device preference so the
      // backend can try to honour it during `AudioDeviceManager`
      // init. If the saved device is no longer present (USB
      // unplugged, etc.) the backend silently falls back to default
      // and tells the renderer via the `fellBackToDefault` flag on
      // `AUDIO_DEVICES_LIST`. The preference itself stays in
      // `preferences.json` so re-plugging the device next launch
      // just works.
      ...(prefs.audioOutput.typeName && prefs.audioOutput.deviceName
        ? {
            SILVERDAW_OUTPUT_DEVICE_TYPE: prefs.audioOutput.typeName,
            SILVERDAW_OUTPUT_DEVICE_NAME: prefs.audioOutput.deviceName
          }
        : {}),
      ...(startupDebugEnabled ? { SILVERDAW_LOG_DIR: getSessionDir() } : {})
    }
  })

  backendProcess.on('exit', (code) => {
    logMain('INFO ', 'backend', `exited with code ${String(code)}`)
    console.log(`[backend] exited with code ${code}`)
    backendProcess = null
  })

  backendProcess.on('error', (err) => {
    logMain('ERROR', 'backend', `failed to start: ${err.message}`)
    console.error('[backend] failed to start:', err)
  })
}

function createWindow(): void {
  const bounds = resolveWindowBounds()
  // Resolve the window icon from `<app>/resources/icons/icon.ico`. The
  // file is optional — if the user hasn't dropped one in yet, Electron
  // falls back to its default and the app still starts cleanly. See
  // `resources/README.md` for the spec.
  const iconPath = join(app.getAppPath(), 'resources', 'icons', 'icon.ico')
  const icon = existsSync(iconPath) ? iconPath : undefined
  if (!icon) {
    logMain('INFO ', 'main', `no app icon at ${iconPath} — using Electron default`)
  }
  mainWindow = new BrowserWindow({
    // Important: do NOT pass x/y/width/height in the constructor on Windows
    // with `titleBarStyle: 'hidden'` + multi-monitor mixed DPI. The
    // constructor interprets those values in a different coordinate space
    // than `getBounds()` reports, causing the saved size to drift bigger
    // on every restart. We hide the window, position+size it explicitly
    // via `setBounds()` (which is symmetric with `getBounds`/`getNormalBounds`),
    // then show it.
    minWidth: 900,
    minHeight: 600,
    backgroundColor: COLOUR_BG,
    icon,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32' || process.platform === 'linux'
        ? { color: COLOUR_BG, symbolColor: COLOUR_FG, height: TITLE_BAR_HEIGHT }
        : undefined,
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: {
      // electron-vite emits the preload bundle as `index.cjs` (CommonJS).
      // Sandboxed renderers can only load CJS preload scripts.
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      // Preload uses only contextBridge / ipcRenderer / webUtils, all of
      // which remain available in a sandboxed preload. Keeping sandbox on
      // restores Chromium's renderer-process isolation guarantees.
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  // Strip Chromium's built-in reload accelerators. A DAW project window
  // has no user-facing reason to reload (it'd be equivalent to closing
  // and reopening the app, except it leaves the backend's audio engine
  // running on a now-orphaned project state — a re-AUTH then bombards
  // the bridge with re-broadcast peaks frames). Dev iteration uses Vite
  // HMR, not full reload; if a dev really needs a full reload they can
  // close and relaunch the renderer.
  //
  // Ctrl+Shift+I / F12 (Chromium's default DevTools shortcuts) are also
  // suppressed when the user has explicitly disabled debug mode in a
  // PACKAGED install. In dev (`!app.isPackaged`) we always leave them
  // available — diagnosing renderer issues without DevTools is
  // unworkable, and there's no end user to protect from the dev menu.
  const RELOAD_KEYS = new Set(['F5', 'F3'])
  const blockDevTools = app.isPackaged && !startupDebugEnabled
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isReloadKey = RELOAD_KEYS.has(input.key) ||
      (input.control && (input.key === 'r' || input.key === 'R')) ||
      (input.meta && (input.key === 'r' || input.key === 'R'))
    if (isReloadKey) {
      event.preventDefault()
      return
    }
    if (blockDevTools) {
      const isDevToolsKey =
        (input.control && input.shift && (input.key === 'i' || input.key === 'I')) ||
        input.key === 'F12'
      if (isDevToolsKey) {
        event.preventDefault()
      }
    }
  })

  // Block any in-page navigation. The renderer is a single-page app
  // (only `index.html` is ever loaded) and we don't want Chromium's
  // default Alt+Left / Alt+Right history bindings hijacking the
  // playhead fine-step shortcut. `will-navigate` fires after the page
  // keyboard handlers have already had a crack at the event, so the
  // renderer's `onTransportKey` still sees Alt+Arrow normally; we
  // just stop the page from actually navigating away.
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  // In a dev session, auto-open DevTools when the user has explicitly
  // enabled debug mode in Preferences. Packaged builds never auto-open —
  // there's the Debug menu's "Toggle Developer Tools" for that — and an
  // unpackaged session with debug off stays clean too (the user can
  // always toggle the preference and relaunch).
  if (!app.isPackaged && startupDebugEnabled) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.openDevTools({ mode: 'right' })
    })
  }

  // Apply saved bounds. Use `setBounds` so we're symmetric with the
  // `getBounds()` we save in `captureWindowState` — round-tripping is
  // stable even on a secondary monitor with a different DPI scale.
  //
  // Windows mixed-DPI workaround: when the constructor-default display has
  // a different scale factor than the target display (e.g. primary @ 125%,
  // secondary @ 100%), the FIRST `setBounds` call applies the size using
  // the previous display's scale, then the window moves to the new
  // display and Electron reports back a size scaled by the ratio. Calling
  // `setBounds` a second time — now that Electron knows which display the
  // window lives on — applies the size at the correct scale.
  if (typeof bounds.x === 'number' && typeof bounds.y === 'number') {
    const rect = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    }
    mainWindow.setBounds(rect)
    if (process.platform === 'win32') mainWindow.setBounds(rect)
  } else {
    mainWindow.setSize(bounds.width, bounds.height)
    mainWindow.center()
  }

  // Restore maximized state without losing the unmaximized bounds: the
  // `setBounds` above used the unmaximized size, so calling `maximize()`
  // now gives us the right "double-click title bar → restore" target.
  if (prefs.window.maximized) mainWindow.maximize()

  // Persist window position / size / maximized state. `resize` and `move`
  // fire continuously while the user drags, so saves are debounced inside
  // `captureWindowState`.
  mainWindow.on('resize', captureWindowState)
  mainWindow.on('move', captureWindowState)
  mainWindow.on('maximize', captureWindowState)
  mainWindow.on('unmaximize', captureWindowState)
  mainWindow.on('close', (event) => {
    captureWindowState()
    void flushPrefsSave()
    // First close attempt: hand control to the renderer so it can
    // prompt for unsaved changes. The renderer either calls
    // `app.confirmClose` (we flip `userConfirmedClose` and re-trigger
    // close, which this branch then lets through) or stays put.
    if (!userConfirmedClose) {
      event.preventDefault()
      mainWindow?.webContents.send('menu:action', 'app.requestClose')
    }
  })

  // Hold the window invisible until index.html has been parsed and the
  // first paint is ready. Otherwise `show()` reveals a blank zinc-900
  // pane (the BrowserWindow.backgroundColor) for the few hundred ms
  // it takes Vite's dev server to deliver index.html — by deferring
  // until ready-to-show, the very first frame already contains the
  // static splash inside <div id="app">.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }
}

/**
 * Menu actions invoked from the custom HTML menu bar via IPC.
 * Most of these are stubs that just log; they will be wired to backend
 * commands as features land.
 */
function handleMenuAction(action: string): void {
  if (!mainWindow) return
  const wc = mainWindow.webContents

  switch (action) {
    // File
    case 'file.newProject':
      wc.send('menu:action', action)
      break
    case 'file.openProject':
      wc.send('menu:action', action)
      break
    case 'file.save':
      wc.send('menu:action', action)
      break
    case 'file.saveAs':
      wc.send('menu:action', action)
      break
    case 'file.renameProject':
      wc.send('menu:action', action)
      break
    case 'file.addTrack':
      // Forwarded to the renderer (see below); the renderer drives the
      // open-file flow so it can decode + render in one place.
      wc.send('menu:action', action)
      break
    case 'file.exportMixdown':
      console.log('[menu] export mixdown (todo)')
      break
    case 'file.exit':
      // Run through the renderer's unsaved-changes guard. The renderer
      // either fires `file.exitConfirmed` (proceed with quit) or stays
      // on the current project.
      wc.send('menu:action', action)
      break
    case 'file.exitConfirmed':
    case 'app.confirmClose':
      // Renderer has cleared the guard. Perform the actual quit /
      // window close. We mark `userConfirmedClose` so the window's
      // own close-event handler stops intercepting.
      userConfirmedClose = true
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) w.destroy()
      })
      app.exit(0)
      break

    // Edit
    case 'edit.undo':
      // Project undo (forwarded to the renderer → `EDIT_UNDO` bridge
      // envelope). Text-input native undo is still reachable via the
      // keyboard shortcut, which `menuShortcuts` keeps out of this
      // path while focus is in an editable target.
      wc.send('menu:action', action)
      break
    case 'edit.redo':
      wc.send('menu:action', action)
      break
    case 'edit.cut':
      // Forward to renderer so it can target the selected clip. The
      // renderer falls back to `wc.cut()` if there's nothing to cut at
      // the clip level — keeps native text-field cut working from the
      // menu UI too.
      wc.send('menu:action', action)
      break
    case 'edit.copy':
      wc.send('menu:action', action)
      break
    case 'edit.paste':
      wc.send('menu:action', action)
      break
    case 'edit.preferences':
      wc.send('menu:action', action)
      break
    case 'edit.splitAtPlayhead':
      // Forwarded to the renderer, which walks every clip whose
      // timeline window straddles the current playhead and splits
      // each at that position.
      wc.send('menu:action', action)
      break
    case 'edit.duplicateClip':
      // Forwarded to the renderer, which duplicates the currently-
      // selected clip immediately after the original on the same track.
      wc.send('menu:action', action)
      break
    case 'edit.deleteClip':
      // Forwarded to the renderer, which removes the currently-selected
      // clip from its track.
      wc.send('menu:action', action)
      break
    case 'edit.cropProjectToLastClip':
      // Forwarded to the renderer, which collapses the project length
      // to the end of the latest clip on any track and emits a single
      // PROJECT_SET_LENGTH envelope so the backend ruler matches.
      wc.send('menu:action', action)
      break

    // View
    case 'view.toggleDevTools':
      wc.toggleDevTools()
      break
    case 'view.toggleFullScreen':
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
      break

    // Help
    case 'help.docs':
      void shell.openExternal('https://github.com/irarainey/silverdaw')
      break
    case 'help.reportIssue':
      void shell.openExternal('https://github.com/irarainey/silverdaw/issues/new')
      break
    case 'help.about':
      // Forwarded to the renderer so the in-app About dialog can render in
      // the same dark Vue UI rather than the native OS message box.
      wc.send('menu:action', action)
      break

    default:
      // Recent Projects entries arrive as `file.openRecentByIndex:<i>`.
      // They're purely renderer-side (the renderer owns the MRU mirror
      // and the open-project flow) so we forward without parsing.
      if (action.startsWith('file.openRecentByIndex:')) {
        wc.send('menu:action', action)
        break
      }
      if (action === 'file.clearRecentProjects') {
        wc.send('menu:action', action)
        break
      }
      console.warn('[menu] unknown action:', action)
  }
}

// ─── .silverdaw file association + single-instance lock ────────────────────
//
// When Windows hands us a `.silverdaw` file (double-click in Explorer, or a
// drag onto the taskbar shortcut), the path arrives as a command-line
// argument. We support two cases:
//
//   1. Cold launch  — first instance of Silverdaw. The path is in
//      `process.argv`; we stash it on `pendingOpenPath` and the renderer
//      consumes it once the bridge is ready.
//   2. Warm launch  — a second invocation while the app is already
//      running. Without a single-instance lock, Electron would spin up a
//      second main process (and a second JUCE backend, fighting for the
//      same port). With the lock, the second instance immediately exits
//      and the `second-instance` event fires in the first process; we
//      pull the path out of its argv, focus the window and forward it
//      to the renderer over `project:openFromPath`.
//
// Path extraction is deliberately conservative: only absolute paths whose
// extension is `.silverdaw` are accepted, so a malicious shortcut can't
// smuggle in non-project arguments. The renderer still runs the same
// allow-list seeding (`prepareProjectOpen`) before sending PROJECT_LOAD.

/** Pull the first `.silverdaw` file path out of an argv array, if any.
 *  argv[0] is the executable; we skip it and ignore Electron CLI flags. */
function extractProjectPathFromArgv(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a || a.startsWith('--') || a.startsWith('-')) continue
    if (!isAbsolute(a)) continue
    if (extname(a).toLowerCase() !== '.silverdaw') continue
    if (!existsSync(a)) continue
    return a
  }
  return null
}

/** Path the renderer should open once the bridge is ready. Captured from
 *  argv at startup or pushed in by a `second-instance` event. */
let pendingOpenPath: string | null = extractProjectPathFromArgv(process.argv)

/** Acquire the single-instance lock. If we don't get it, another Silverdaw
 *  is already running — it will handle our argv via `second-instance` and
 *  this process should quit immediately. */
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  // `app.quit()` is async (it fires `before-quit` first). Calling
  // `app.exit(0)` instead guarantees we're gone before whenReady has a
  // chance to fire and double-spawn the backend.
  app.exit(0)
}

app.on('second-instance', (_event, argv) => {
  const filePath = extractProjectPathFromArgv(argv)
  // Bring the existing window forward regardless of whether a file path
  // was supplied — the user clicking the taskbar shortcut while the app
  // is open should focus it.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  if (filePath && mainWindow) {
    // Push directly to the renderer; it runs the same unsaved-changes
    // guard + prepareProjectOpen + requestLoad flow as File > Open.
    mainWindow.webContents.send('project:openFromPath', filePath)
  }
})

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'

  // Windows: associate the running process with a stable AppUserModelID
  // so the taskbar groups our windows under one icon and the start-menu
  // pin (post-install, Phase 6) targets the right shortcut. Must be set
  // BEFORE the first BrowserWindow is created.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.silverdaw.app')
  }

  // Load persisted preferences (window bounds, UI panel sizes, debug
  // toggle) BEFORE we decide whether to spin up the cross-layer logger
  // — debug mode is gated on `prefs.debug.enabled` and the snapshot
  // taken here is what every subsequent component reads.
  await loadPreferences()
  startupDebugEnabled = prefs.debug.enabled === true

  // Initialise the cross-layer file logger only when the user has opted
  // in via Preferences. When off, `logMain` / `logRendererLine` / the
  // backend's `silverdaw::log::*` calls all become silent no-ops — so
  // a normal-use session never writes a `.logs/` directory.
  if (startupDebugEnabled) {
    // `<repo>` in dev, `userData` in a packaged install — same logic as
    // before so dev iteration drops logs alongside the source tree.
    const repoRoot = !app.isPackaged
      ? pathResolve(__dirname, '..', '..', '..')
      : pathResolve(app.getPath('userData'))
    const sessionDir = initLogs(repoRoot)
    logMain('INFO ', 'main', `session log dir: ${sessionDir}`)
    logMain('INFO ', 'main', `electron=${process.versions.electron} node=${process.versions.node}`)
  } else {
    console.log('[main] debug logging disabled (Preferences > Enable Debugging is off)')
  }

  // Hide the native application menu — we render our own in HTML.
  Menu.setApplicationMenu(null)

  ipcMain.on('menu:action', (_evt, action: string) => handleMenuAction(action))

  // Renderer-side logger flushes batches of structured log entries here so
  // they land in the same session directory as main / backend events.
  // Each entry is { level, tag, message, timestamp }; the level is the
  // same 5-char padded form used by the backend so columns align.
  ipcMain.handle(
    'log:append-batch',
    (_evt, entries: Array<{ level: LogLevel; tag: string; message: string; timestamp: number }>) => {
      if (!Array.isArray(entries)) return
      for (const e of entries) {
        if (!e || typeof e.tag !== 'string' || typeof e.message !== 'string') continue
        logRendererLine(e.level ?? 'INFO ', e.tag, e.message, e.timestamp)
      }
    }
  )

  // Tell the renderer which port the JUCE bridge is listening on. Resolved
  // once at main-process start (env var or default) and shared with the
  // spawned backend via `--port`.
  ipcMain.handle('bridge:getPort', () => bridgePort)

  // Hand the renderer the per-session AUTH token so it can send the
  // initial `{type:'AUTH',payload:{token}}` envelope. The token never
  // appears in argv or in the renderer's HTML — only the trusted preload
  // bridge can fetch it.
  ipcMain.handle('bridge:getToken', () => bridgeToken)

  // Static app / runtime info for the in-app About dialog. Resolved once at
  // start; never changes for the lifetime of the process.
  ipcMain.handle('app:getInfo', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node
  }))

  // Open an external URL in the user's default browser. We only forward
  // http/https — anything else (file:, data:, custom schemes) is dropped.
  ipcMain.on('app:openExternal', (_evt, url: unknown) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
    void shell.openExternal(parsed.toString())
  })


  // Open an audio file via the OS dialog and stream its bytes back to the renderer.
  // Returns null if the user cancels.
  ipcMain.handle('audio:open', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add Track from File',
      defaultPath: currentClipDir || undefined,
      filters: [{ name: 'Audio files', extensions: [...AUDIO_FILE_EXTENSIONS] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    rememberClipDir(filePath)
    const buf = await readFile(filePath)
    // Copy into a plain ArrayBuffer so it survives the IPC boundary cleanly.
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // Whitelist this path so the renderer can re-read it later via
    // `audio:readFile` (e.g. when the user re-imports the same file).
    registerIssuedPath(filePath)
    return { filePath, fileName: basename(filePath), data }
  })

  // Multi-file variant used by the library panel's Import button.
  // Returns an array of opened files (paths + bytes) or `[]` if cancelled.
  ipcMain.handle('audio:openMany', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Audio into Library',
      defaultPath: currentClipDir || undefined,
      filters: [{ name: 'Audio files', extensions: [...AUDIO_FILE_EXTENSIONS] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    rememberClipDir(result.filePaths[0])
    const out: { filePath: string; fileName: string; data: ArrayBuffer }[] = []
    for (const filePath of result.filePaths) {
      try {
        const buf = await readFile(filePath)
        const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        registerIssuedPath(filePath)
        out.push({ filePath, fileName: basename(filePath), data })
      } catch (err) {
        console.error('[audio:openMany] read failed for', filePath, err)
      }
    }
    return out
  })

  // Show the OS audio-file picker but return only the chosen path —
  // no bytes are read, no allow-list registration happens here. Used
  // by the relink-missing-files flow where the bytes will be loaded
  // by the BACKEND when it re-creates the clip's audio source, not by
  // the renderer. The file's parent directory is added to the path
  // allow-list so the subsequent `audio:readMetadata` for cover-art
  // refresh works without a separate registerDroppedPath round-trip.
  ipcMain.handle(
    'audio:chooseFile',
    async (_evt, args: unknown): Promise<string | null> => {
      if (!mainWindow) return null
      const a = (args ?? {}) as { title?: string; defaultPath?: string }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: typeof a.title === 'string' ? a.title : 'Locate audio file',
        defaultPath:
          typeof a.defaultPath === 'string' && a.defaultPath.length > 0
            ? a.defaultPath
            : currentClipDir || undefined,
        filters: [{ name: 'Audio files', extensions: [...AUDIO_FILE_EXTENSIONS] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const picked = result.filePaths[0]
      rememberClipDir(picked)
      registerIssuedPath(picked)
      return picked
    }
  )

  // Renderer reports a path it obtained from an OS drag-drop via
  // `webUtils.getPathForFile`. The path is added to the allow-list so the
  // follow-up `audio:readFile` / `audio:readMetadata` calls will pass the
  // FE-004 guard. We intentionally do NO further validation here: only the
  // OS shell can have populated this string (the renderer can't fabricate
  // a `File` with an arbitrary path), and even if it could, the actual
  // read still has to satisfy the extension allow-list below.
  ipcMain.on('audio:registerDroppedPath', (_evt, filePath: unknown) => {
    if (typeof filePath !== 'string') return
    registerIssuedPath(filePath)
  })

  // Read an audio file by absolute path (e.g. one obtained from an OS
  // drag-drop via `webUtils.getPathForFile`). Returns null on failure or
  // when the path is not on the allow-list.
  ipcMain.handle('audio:readFile', async (_evt, filePath: unknown) => {
    if (!isAllowedAudioPath(filePath)) {
      console.warn('[audio:readFile] rejected path not on allow-list:', filePath)
      return null
    }
    try {
      const buf = await readFile(filePath)
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      return { filePath, fileName: basename(filePath), data }
    } catch (err) {
      console.error('[audio:readFile] failed for', filePath, err)
      return null
    }
  })

  // Extract ID3 / Vorbis / iTunes / BWF metadata from an audio file. Returns
  // a normalized subset of fields the renderer can display in the library
  // card and tooltip. Resolves to `null` if parsing fails (the import still
  // succeeds with only the technical info from Web Audio).
  ipcMain.handle('audio:readMetadata', async (_evt, filePath: unknown) => {
    if (!isAllowedAudioPath(filePath)) {
      console.warn('[audio:readMetadata] rejected path not on allow-list:', filePath)
      return null
    }
    try {
      const meta = await parseFile(filePath, { duration: true, skipCovers: false })
      return normalizeMetadata(meta)
    } catch (err) {
      console.warn('[audio:readMetadata] failed for', filePath, err)
      return null
    }
  })

  // Write decoded PCM (from the renderer's Web Audio decoder) to a temp
  // WAV file the JUCE backend can read. Used for formats the backend's
  // AudioFormatManager doesn't understand natively on this platform —
  // notably AAC / M4A / MP4 on Windows, where JUCE's bundled formats only
  // cover WAV/AIFF/FLAC/Ogg + the Windows Media SDK (WMA family + MP3).
  //
  // Returns the absolute path to the written WAV, or `null` on failure.
  // The path is added to the audio allow-list so the renderer may re-read
  // it via `audio:readFile` if it ever needs to (the backend reads it via
  // its own filesystem access, independently of the allow-list).
  ipcMain.handle('audio:writeTempWav', async (_evt, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return null
    const p = payload as {
      sourcePath?: unknown
      channels?: unknown
      sampleRate?: unknown
    }
    if (typeof p.sourcePath !== 'string' || !isAllowedAudioPath(p.sourcePath)) {
      console.warn('[audio:writeTempWav] rejected source not on allow-list:', p.sourcePath)
      return null
    }
    if (typeof p.sampleRate !== 'number' || !Number.isFinite(p.sampleRate) || p.sampleRate <= 0) {
      return null
    }
    if (!Array.isArray(p.channels) || p.channels.length === 0 || p.channels.length > 8) {
      return null
    }
    const chans: Float32Array[] = []
    let frameCount = -1
    for (const c of p.channels) {
      let arr: Float32Array
      if (c instanceof Float32Array) {
        arr = c
      } else if (c instanceof ArrayBuffer) {
        arr = new Float32Array(c)
      } else if (ArrayBuffer.isView(c)) {
        const view = c as ArrayBufferView
        arr = new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4)
      } else {
        return null
      }
      if (frameCount < 0) frameCount = arr.length
      else if (arr.length !== frameCount) return null
      chans.push(arr)
    }
    if (frameCount <= 0) return null

    try {
      await mkdir(TRANSCODE_CACHE_DIR, { recursive: true })
    } catch (err) {
      console.error('[audio:writeTempWav] failed to create cache dir:', err)
      return null
    }

    // Cache key includes channel + frame + rate so a re-decode that
    // produced different output (sample-rate change, etc.) won't collide.
    const hash = createHash('sha1')
      .update(canonicalisePath(p.sourcePath))
      .update(`|sr=${p.sampleRate}|ch=${chans.length}|n=${frameCount}`)
      .digest('hex')
      .slice(0, 16)
    const outPath = join(TRANSCODE_CACHE_DIR, `${hash}.wav`)

    // 32-bit float WAV (WAVE_FORMAT_IEEE_FLOAT, code 0x0003). JUCE's WAV
    // reader handles both float and integer PCM; float avoids quantising
    // the renderer's already-decoded sample data.
    const numChannels = chans.length
    const bitsPerSample = 32
    const byteRate = p.sampleRate * numChannels * 4
    const blockAlign = numChannels * 4
    const dataSize = frameCount * blockAlign
    const headerSize = 44
    const buf = Buffer.alloc(headerSize + dataSize)

    let off = 0
    buf.write('RIFF', off)
    off += 4
    buf.writeUInt32LE(headerSize + dataSize - 8, off)
    off += 4
    buf.write('WAVE', off)
    off += 4
    buf.write('fmt ', off)
    off += 4
    buf.writeUInt32LE(16, off)
    off += 4
    buf.writeUInt16LE(3 /* IEEE_FLOAT */, off)
    off += 2
    buf.writeUInt16LE(numChannels, off)
    off += 2
    buf.writeUInt32LE(p.sampleRate, off)
    off += 4
    buf.writeUInt32LE(byteRate, off)
    off += 4
    buf.writeUInt16LE(blockAlign, off)
    off += 2
    buf.writeUInt16LE(bitsPerSample, off)
    off += 2
    buf.write('data', off)
    off += 4
    buf.writeUInt32LE(dataSize, off)
    off += 4
    // Interleave planar channels frame-by-frame.
    for (let f = 0; f < frameCount; f++) {
      for (let c = 0; c < numChannels; c++) {
        buf.writeFloatLE(chans[c]![f]!, off)
        off += 4
      }
    }

    try {
      await writeFile(outPath, buf)
    } catch (err) {
      console.error('[audio:writeTempWav] failed to write WAV:', err)
      return null
    }
    registerIssuedPath(outPath)
    return outPath
  })

  // Hand the renderer its persisted preferences (UI panel sizes etc.) on
  // request. Window bounds are applied by main so they aren't included.
  ipcMain.handle('prefs:getUi', () => prefs.ui)

  // Update one or more UI preference keys. Explicit Preferences-dialog saves
  // should be durable immediately; high-frequency window bounds still use the
  // debounced writer in `captureWindowState`.
  ipcMain.on('prefs:setUi', (_evt, partial: Partial<UiPrefs>) => {
    prefs.ui = { ...prefs.ui, ...partial }
    flushPrefsSaveSync()
  })

  // ─── Debug preferences ──────────────────────────────────────────────────
  // `startupDebugEnabled` is the value sampled at launch and used for
  // logger init + menu visibility. `prefs.debug.enabled` is the live
  // persisted value that may differ if the user has toggled it during
  // this session — the change takes effect on next launch.

  ipcMain.handle('debug:getStartupEnabled', () => startupDebugEnabled)
  ipcMain.handle('debug:getEnabled', () => prefs.debug.enabled === true)
  ipcMain.on('debug:setEnabled', (_evt, value: unknown) => {
    const next = value === true
    if (prefs.debug.enabled === next) return
    prefs.debug = { ...prefs.debug, enabled: next }
    // Debug logging only takes effect after a restart, so this must
    // hit disk before the user immediately quits/relaunches. The
    // debounced async preference writer can be skipped by process exit.
    flushPrefsSaveSync()
  })

  // ─── Quality-of-life preferences (toasts, default paths) ────────────────
  // Used by the Preferences dialog. The renderer reads everything in one
  // round-trip and writes back partial updates as the user changes them.
  ipcMain.handle('prefs:getQol', () => ({
    toasts: { ...prefs.toasts },
    paths: { ...prefs.paths }
  }))

  ipcMain.on('prefs:setQol', (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as {
      toasts?: Partial<ToastPrefs>
      paths?: Partial<PathPrefs>
    }
    if (p.toasts && typeof p.toasts.enabled === 'boolean') {
      prefs.toasts = { ...prefs.toasts, enabled: p.toasts.enabled }
    }
    if (p.paths) {
      const nextPaths: PathPrefs = { ...prefs.paths }
      if (typeof p.paths.defaultProjectDir === 'string' && p.paths.defaultProjectDir.length > 0) {
        nextPaths.defaultProjectDir = p.paths.defaultProjectDir
      }
      if (typeof p.paths.defaultClipDir === 'string' && p.paths.defaultClipDir.length > 0) {
        nextPaths.defaultClipDir = p.paths.defaultClipDir
        // Reset the in-memory session pointer too — the user's
        // intuition is "I changed the default, now use it" rather than
        // "use it on next launch".
        currentClipDir = p.paths.defaultClipDir
      }
      prefs.paths = nextPaths
      // Make sure the new project dir is on disk — same reasoning as
      // the startup ensure call. Fire-and-forget; failures just leave
      // the dialog to fall back to the home folder.
      void ensureProjectDirExists()
    }
    flushPrefsSaveSync()
  })

  /**
   * Show an OS folder-picker dialog. `defaultPath` seeds the starting
   * directory; both args are optional. Returns the chosen absolute
   * path or `null` if the user cancelled. Used by the Preferences
   * dialog's "Change…" buttons for the two default-paths fields.
   */
  ipcMain.handle(
    'prefs:chooseDirectory',
    async (_evt, args: unknown): Promise<string | null> => {
      if (!mainWindow) return null
      const a = (args ?? {}) as { title?: string; defaultPath?: string }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: typeof a.title === 'string' ? a.title : 'Choose folder',
        defaultPath: typeof a.defaultPath === 'string' ? a.defaultPath : undefined,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )

  // ─── Project file lifecycle ─────────────────────────────────────────────
  // Helpers used by the renderer to drive Save / Save As / Open menus. Main
  // owns the native OS dialog plus the Recent Projects MRU so the app can
  // surface it in the File menu and on the Start Screen. The MRU head
  // doubles as the "last opened project" — there's no separate slot.

  ipcMain.on('project:setLastPath', (_evt, value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return
    // A successful save / load bumps the Recent Projects MRU. Bridge
    // service calls this IPC from both the PROJECT_SAVED arm and the
    // `reset=true && filePath` PROJECT_STATE arm, so every
    // user-visible "I just opened this file" event is captured.
    if (bumpRecentProject(value)) flushPrefsSaveSync()
  })

  ipcMain.handle('project:fileExists', async (_evt, value: unknown): Promise<boolean> => {
    if (typeof value !== 'string' || value.length === 0) return false
    try {
      await readFile(value, { encoding: null, flag: 'r' })
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('project:chooseOpen', async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Silverdaw Project',
      defaultPath: prefs.paths.defaultProjectDir || undefined,
      filters: [{ name: 'Silverdaw project', extensions: ['silverdaw'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'project:chooseSaveAs',
    async (_evt, defaultName: unknown): Promise<string | null> => {
      if (!mainWindow) return null
      const suggested =
        typeof defaultName === 'string' && defaultName.length > 0 ? defaultName : 'Untitled'
      // Seed the save dialog inside the configured project folder so the
      // user lands in the right place by default, but keep the filename
      // suggestion intact.
      const defaultPath = prefs.paths.defaultProjectDir
        ? join(prefs.paths.defaultProjectDir, `${suggested}.silverdaw`)
        : `${suggested}.silverdaw`
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Silverdaw Project',
        defaultPath,
        filters: [{ name: 'Silverdaw project', extensions: ['silverdaw'] }]
      })
      if (result.canceled || !result.filePath) return null
      return result.filePath
    }
  )

  /**
   * Pre-register every audio path referenced by `<filePath="...">`
   * attributes inside the supplied `.silverdaw` XML file. Called by the
   * renderer right before it fires `PROJECT_LOAD` (both for the
   * user-driven File > Open flow and the auto-open-last-project on
   * launch). Without this the renderer's post-load
   * `audio:readMetadata` calls — fired to refresh cover art on the
   * library cards — get rejected by the allow-list, leaving every
   * library card with a generic icon.
   *
   * The path-validation rules inside `registerIssuedPath` still apply
   * (absolute path + known audio extension), so a malicious file can't
   * smuggle e.g. `C:\Windows\notepad.exe` onto the read whitelist.
   *
   * Returns true if the project file was readable; per-path
   * registration failures are silent (the renderer will surface them
   * later as missing-file toasts when the backend tries to load them).
   */
  ipcMain.handle('project:prepareOpen', async (_evt, filePath: unknown): Promise<boolean> => {
    if (typeof filePath !== 'string' || filePath.length === 0) return false
    if (extname(filePath).toLowerCase() !== '.silverdaw') return false
    try {
      const content = await readFile(filePath, 'utf8')
      // `.silverdaw` files are JSON; the audio paths used by clips
      // live in `filePath` properties anywhere inside the tree. We
      // walk the parsed object recursively and register every value
      // we find under that key. `registerIssuedPath` itself enforces
      // the absolute-path + audio-extension allow-list, so even a
      // tampered project file can't smuggle non-audio paths onto the
      // read whitelist.
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (parseErr) {
        console.warn('[project:prepareOpen] malformed project JSON:', filePath, parseErr)
        return false
      }
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) visit(item)
          return
        }
        if (node !== null && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            if (k === 'filePath' && typeof v === 'string' && v.length > 0) {
              registerIssuedPath(v)
            } else {
              visit(v)
            }
          }
        }
      }
      visit(parsed)
      return true
    } catch (err) {
      console.warn('[project:prepareOpen] could not read project file:', filePath, err)
      return false
    }
  })

  /**
   * Renderer-side bootstrap calls this once the bridge is ready, asking
   * main "did the user launch us by double-clicking a .silverdaw file?".
   * If so we hand back the path (clearing it so a later reload doesn't
   * re-open the same project) and the renderer drives the normal load
   * flow. Returns `null` when there's no pending path.
   */
  ipcMain.handle('project:consumePendingOpenPath', (): string | null => {
    const p = pendingOpenPath
    pendingOpenPath = null
    return p
  })

  // ─── Recent projects (MRU) ─────────────────────────────────────────────
  ipcMain.handle('prefs:getRecentProjects', (): string[] => [...prefs.recentProjects])

  ipcMain.on('prefs:removeRecentProject', (_evt, value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return
    const key = value.toLowerCase()
    const before = prefs.recentProjects.length
    prefs.recentProjects = prefs.recentProjects.filter((p) => p.toLowerCase() !== key)
    if (prefs.recentProjects.length !== before) flushPrefsSaveSync()
  })

  ipcMain.on('prefs:clearRecentProjects', () => {
    if (prefs.recentProjects.length === 0) return
    prefs.recentProjects = []
    flushPrefsSaveSync()
  })

  // ─── Autosave preferences ───────────────────────────────────────────────
  ipcMain.handle(
    'prefs:getAutosaveConfig',
    (): { enabled: boolean; intervalSeconds: number } => ({ ...prefs.autosave })
  )

  ipcMain.on('prefs:setAutosaveConfig', (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as Partial<AutosavePrefs>
    let changed = false
    if (typeof p.enabled === 'boolean' && p.enabled !== prefs.autosave.enabled) {
      prefs.autosave = { ...prefs.autosave, enabled: p.enabled }
      changed = true
    }
    if (typeof p.intervalSeconds === 'number' && Number.isFinite(p.intervalSeconds)) {
      const clamped = clampAutosaveSeconds(p.intervalSeconds)
      if (clamped !== prefs.autosave.intervalSeconds) {
        prefs.autosave = { ...prefs.autosave, intervalSeconds: clamped }
        changed = true
      }
    }
    if (changed) schedulePrefsSave()
  })

  // ─── Audio output device preferences ────────────────────────────────────
  //
  // The renderer's `audioDeviceStore` is the source of truth at
  // runtime; this IPC is just the persistence path. Renderer calls
  // `setAudioOutput` only after the backend acks an
  // `AUDIO_DEVICE_SELECT` with `ok: true`, so a saved device that
  // failed to open never gets persisted (and won't repeatedly fail
  // on subsequent launches).
  ipcMain.handle(
    'prefs:getAudioOutput',
    (): { typeName: string | null; deviceName: string | null } => ({ ...prefs.audioOutput })
  )

  ipcMain.on('prefs:setAudioOutput', (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as Partial<AudioOutputPrefs>
    const nextTypeName = typeof p.typeName === 'string' && p.typeName.length > 0 ? p.typeName : null
    const nextDeviceName =
      typeof p.deviceName === 'string' && p.deviceName.length > 0 ? p.deviceName : null
    if (
      prefs.audioOutput.typeName === nextTypeName &&
      prefs.audioOutput.deviceName === nextDeviceName
    ) {
      return
    }
    prefs.audioOutput = { typeName: nextTypeName, deviceName: nextDeviceName }
    schedulePrefsSave()
  })

  // ─── Autosave folder + manifest IPCs ────────────────────────────────────
  //
  // The renderer's autosave manager drives writes. Main owns the
  // filesystem side — folder creation, manifest write, recovery scan,
  // and bucket cleanup — so the renderer never touches paths outside
  // `%APPDATA%/Silverdaw/autosave/<projectId>/`. Every accepted
  // `projectId` is validated against `AUTOSAVE_ID_REGEX` first.

  ipcMain.handle(
    'autosave:resolveDir',
    async (_evt, projectId: unknown): Promise<{ dir: string; filePath: string } | null> => {
      if (typeof projectId !== 'string') return null
      try {
        const dir = resolveAutosaveDir(projectId)
        await mkdir(dir, { recursive: true })
        return { dir, filePath: join(dir, AUTOSAVE_FILENAME) }
      } catch (err) {
        console.warn('[autosave:resolveDir]', err)
        return null
      }
    }
  )

  ipcMain.handle('autosave:writeManifest', async (_evt, payload: unknown): Promise<boolean> => {
    if (!payload || typeof payload !== 'object') return false
    const p = payload as Partial<AutosaveManifest>
    if (typeof p.projectId !== 'string' || !AUTOSAVE_ID_REGEX.test(p.projectId)) return false
    const manifest: AutosaveManifest = {
      projectId: p.projectId,
      originalPath: typeof p.originalPath === 'string' && p.originalPath.length > 0 ? p.originalPath : null,
      projectName: typeof p.projectName === 'string' ? p.projectName : 'Untitled',
      savedAtIso: typeof p.savedAtIso === 'string' ? p.savedAtIso : new Date().toISOString(),
      pending: typeof p.pending === 'boolean' ? p.pending : false,
      appVersion: app.getVersion()
    }
    try {
      const dir = resolveAutosaveDir(manifest.projectId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, AUTOSAVE_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8')
      return true
    } catch (err) {
      console.warn('[autosave:writeManifest]', err)
      return false
    }
  })

  ipcMain.handle('autosave:listRecoverable', async (): Promise<
    Array<{
      projectId: string
      originalPath: string | null
      projectName: string
      autosavePath: string
      savedAtIso: string
      originalExists: boolean
    }>
  > => {
    const root = getAutosaveRoot()
    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      return []
    }
    const out: Array<{
      projectId: string
      originalPath: string | null
      projectName: string
      autosavePath: string
      savedAtIso: string
      originalExists: boolean
    }> = []
    for (const projectId of entries) {
      if (!AUTOSAVE_ID_REGEX.test(projectId)) continue
      const dir = join(root, projectId)
      const manifestPath = join(dir, AUTOSAVE_MANIFEST_FILENAME)
      const autosavePath = join(dir, AUTOSAVE_FILENAME)
      let manifest: AutosaveManifest | null = null
      try {
        const raw = await readFile(manifestPath, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (isAutosaveManifest(parsed)) manifest = parsed
      } catch {
        manifest = null
      }
      if (!manifest) continue
      if (manifest.pending) continue
      let autosaveStat: Awaited<ReturnType<typeof stat>> | null = null
      try {
        autosaveStat = await stat(autosavePath)
      } catch {
        // No autosave file on disk — manifest is orphaned. Skip.
        continue
      }
      // Recoverable iff the autosave is newer than its backing file
      // (or the backing file is missing / nonexistent / null).
      let originalExists = false
      let recoverable = manifest.originalPath === null
      if (manifest.originalPath) {
        try {
          const origStat = await stat(manifest.originalPath)
          originalExists = true
          if (autosaveStat.mtimeMs > origStat.mtimeMs + 500) recoverable = true
        } catch {
          // Original gone — definitely recoverable.
          recoverable = true
        }
      }
      if (!recoverable) continue
      out.push({
        projectId: manifest.projectId,
        originalPath: manifest.originalPath,
        projectName: manifest.projectName,
        autosavePath,
        savedAtIso: manifest.savedAtIso,
        originalExists
      })
    }
    // Most recent first.
    out.sort((a, b) => (a.savedAtIso < b.savedAtIso ? 1 : -1))
    return out
  })

  ipcMain.handle('autosave:clear', async (_evt, projectId: unknown): Promise<boolean> => {
    if (typeof projectId !== 'string' || !AUTOSAVE_ID_REGEX.test(projectId)) return false
    try {
      const dir = resolveAutosaveDir(projectId)
      // Verify the dir is under the autosave root (paranoid double-check
      // — `AUTOSAVE_ID_REGEX` already prevents traversal, but the cost
      // is one extra `startsWith` so do it anyway).
      const root = getAutosaveRoot()
      const canonical = pathResolve(dir)
      const canonicalRoot = pathResolve(root)
      if (!canonical.toLowerCase().startsWith(canonicalRoot.toLowerCase())) {
        console.warn('[autosave:clear] refused traversal:', canonical)
        return false
      }
      await rm(canonical, { recursive: true, force: true })
      return true
    } catch (err) {
      console.warn('[autosave:clear]', err)
      return false
    }
  })

  /**
   * Read a peaks cache file from `%APPDATA%/Silverdaw/peaks/`. The
   * backend writes peaks to that directory and sends the renderer a
   * `WAVEFORM_READY { cachePath }` envelope; the renderer fetches the
   * bytes via this IPC and parses the header + float32 payload locally.
   *
   * Path validation: must canonicalise into the peaks cache directory
   * exactly (no symlinks, no traversal). Anything else is refused —
   * even a compromised renderer can only read files this main process
   * actively produced.
   */
  const peaksCacheDir = pathResolve(app.getPath('appData'), 'Silverdaw', 'peaks')
  ipcMain.handle('peaks:readCacheFile', async (_evt, value: unknown): Promise<ArrayBuffer | null> => {
    if (typeof value !== 'string' || value.length === 0) return null
    const canonical = pathResolve(value)
    if (!canonical.toLowerCase().startsWith(peaksCacheDir.toLowerCase() + '\\') &&
        canonical.toLowerCase() !== peaksCacheDir.toLowerCase()) {
      console.warn('[peaks:readCacheFile] refused path outside cache dir:', canonical)
      return null
    }
    try {
      const buf = await readFile(canonical)
      // Return as a fresh ArrayBuffer so the structured-clone IPC hop
      // delivers a clean, contiguous buffer to the renderer.
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    } catch (err) {
      console.warn('[peaks:readCacheFile] read failed:', canonical, err)
      return null
    }
  })

  // Pick the WebSocket port the backend will listen on. When the dev
  // env var is set we honour it as-is (developer intent); otherwise we
  // probe a small range starting at the default port so a leftover
  // Silverdaw process holding 8765 doesn't lock new instances out of
  // launching. The renderer fetches whatever we settle on via
  // `bridge:getPort` so all three processes agree.
  if (!bridgePortEnvOverridden) {
    const free = await findFreeBridgePort(DEFAULT_BRIDGE_PORT, 20)
    if (free === null) {
      const msg =
        `Could not find a free TCP port for the audio engine in the range ` +
        `${DEFAULT_BRIDGE_PORT}–${DEFAULT_BRIDGE_PORT + 19}. ` +
        `Close any other running Silverdaw windows and try again.`
      // Surface to the user via a native dialog because the renderer
      // window doesn't exist yet; then exit so the broken launch
      // doesn't leave an idle Electron in the taskbar.
      dialog.showErrorBox('Unable to start Silverdaw', msg)
      app.exit(1)
      return
    }
    if (free !== bridgePort) {
      console.log(`[main] port ${bridgePort} busy; using ${free} instead`)
    }
    bridgePort = free
  }

  // Create the window first so the user sees a frame immediately; defer
  // backend-process spawn to the next tick so it doesn't contend with the
  // renderer for CPU during initial paint.
  createWindow()
  setImmediate(startBackend)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
  // Make sure any pending debounced write hits disk before we exit.
  flushPrefsSaveSync()
  logMain('INFO ', 'main', 'before-quit')
  closeLogs()
})
