// WebSocket bridge to the JUCE backend.
//
// - Connects to `ws://127.0.0.1:<port>` on `connect()`, where `<port>` is
//   resolved from main via `window.silverdaw.getBridgePort()` so the renderer
//   and the spawned backend always agree on a single port (chosen by main).
// - Reconnects with backoff if the socket drops (backend restarts during dev).
// - Dispatches incoming `{ type, payload }` envelopes to the appropriate
//   Pinia store; provides a typed `send()` for outgoing commands.
//
// The wire protocol — every legal envelope `type` and its payload shape — is
// catalogued in `@shared/bridge-protocol`. Outgoing `send()` is constrained
// to that catalogue via the `BridgeOutboundArgs` tuple type, and incoming
// messages are validated by `isBridgeInboundType` + the per-arm payload
// guards before they reach the Pinia stores.
//
// **Text only.** Every envelope is a JSON `{ type, payload }` text frame.
// Bulk data (peaks today, stems / previews later) is delivered via the
// on-disk cache and a small "ready" envelope pointing at the cache path —
// see `WAVEFORM_READY` and `loadPeaksFromCache` below. Treating the
// WebSocket as a control plane only sidesteps the IXWebSocket I/O-loop
// starvation issues we hit when bulk frames competed with control traffic
// for the same single-threaded loop on Windows.
//
// **File-size note (documented exception).** This module is a connection
// singleton: the watchdog/heartbeat, connect/reconnect lifecycle, audio-file
// probe and the exhaustive inbound `dispatch()` switch all read and mutate the
// same module-level socket + timer + counter state, so they cannot be split
// into separate files without a contrived shared-state object that would hurt
// readability more than the line count helps (see the TS instructions on
// justified exceptions). The two genuinely independent concerns have been
// extracted to sibling modules: `bridge/peaksCache` (binary peaks decoding) and
// `bridge/inboundValidation` (envelope validation + narrowing). Prefer
// extracting any further self-contained concern over growing `dispatch()`.

import { useTransportStore } from '@/stores/transportStore'
import { useProjectStore } from '@/stores/projectStore'
import { useAppStore } from '@/stores/appStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { applyMixdownProgress, clearMixdownState, snapshotMixdownState } from '@/lib/mixdownState'
import { clearMasterLevels, setMasterLevels } from '@/lib/audio/masterLevelChannel'
import { clearTrackLevels, setTrackLevels } from '@/lib/audio/trackLevelsChannel'
import { usePreviewStore } from '@/stores/previewStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import * as engineRecovery from '@/lib/engineRecovery'
import { log } from '@/lib/log'
import {
  type AudioFileProbedPayload,
  type BridgeInboundMessage,
  type BridgeOutboundArgs,
  type BridgeOutboundType
} from '@shared/bridge-protocol'

import { applySampleSaved, loadEditorPeaksFromCache, loadPeaksFromCache } from '@/lib/bridge/peaksCache'
import { assertNever, validateInbound } from '@/lib/bridge/inboundValidation'

const BRIDGE_HOST = '127.0.0.1'
const DEFAULT_BRIDGE_PORT = 8765
const RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 5000

// ─── Liveness watchdog tuning ───────────────────────────────────────────────
// The backend only pushes data (PLAYHEAD_UPDATE) during playback, so when
// the session is idle there is no inbound traffic to prove the engine's
// message thread is still alive. The watchdog fills that gap: after a quiet
// spell it sends a PING and expects a PONG handled ON the engine's message
// thread. Missing several in a row means the engine is wedged → force a
// supervised restart. Tuned for ~7–11 s detection without false positives.
const WATCHDOG_INTERVAL_MS = 1000
/** Quiet period (no inbound) before we start actively pinging. */
const WATCHDOG_IDLE_MS = 3000
/** How long to wait for a PONG before counting it as missed. */
const WATCHDOG_PONG_TIMEOUT_MS = 2000
/** Consecutive missed PONGs that declare the engine hung. */
const WATCHDOG_MAX_MISSED = 3
/** Tick gap beyond this implies the machine slept — treat as resume. */
const WATCHDOG_DRIFT_MS = 4000

/** Raw `{type, payload}` envelope as it arrives off the wire (pre-validation). */
let socket: WebSocket | null = null
let reconnectDelay = RECONNECT_DELAY_MS
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false
let socketHeartbeat: ReturnType<typeof setInterval> | null = null
let outboundCount = 0
let inboundCount = 0
let lastInboundAt = 0
// Watchdog state.
let pingNonce = 0
let pendingPing: { id: number; sentAt: number } | null = null
let missedPongs = 0
let lastWatchdogTickAt = 0

function readyStateName(s: number): string {
  switch (s) {
    case WebSocket.CONNECTING:
      return 'CONNECTING'
    case WebSocket.OPEN:
      return 'OPEN'
    case WebSocket.CLOSING:
      return 'CLOSING'
    case WebSocket.CLOSED:
      return 'CLOSED'
    default:
      return `UNKNOWN(${s})`
  }
}

function startSocketHeartbeat(): void {
  if (socketHeartbeat) return
  lastWatchdogTickAt = performance.now()
  socketHeartbeat = setInterval(runWatchdogTick, WATCHDOG_INTERVAL_MS)
}

/**
 * One watchdog tick. Logs perf telemetry, then — when the session is idle
 * and the engine isn't legitimately busy — probes liveness with PING/PONG
 * and escalates to a supervised restart after repeated misses.
 */
function runWatchdogTick(): void {
  if (!socket) return
  const now = performance.now()
  const driftMs = lastWatchdogTickAt > 0 ? now - lastWatchdogTickAt - WATCHDOG_INTERVAL_MS : 0
  lastWatchdogTickAt = now

  const lastInboundAgeMs = lastInboundAt > 0 ? now - lastInboundAt : -1
  log.debug(
    'perf.bridge',
    `heartbeat readyState=${readyStateName(socket.readyState)} bufferedAmount=${socket.bufferedAmount} ` +
      `out=${outboundCount} in=${inboundCount} lastInboundAgeMs=${lastInboundAgeMs.toFixed(0)} ` +
      `missedPongs=${missedPongs}`
  )

  // Large positive drift means the OS suspended us (sleep / hibernate).
  // Any "missed" PONG across that gap is a false positive — reset and let
  // the next clean interval re-evaluate.
  if (driftMs > WATCHDOG_DRIFT_MS) {
    log.info('perf.bridge', `clock drift ${driftMs.toFixed(0)}ms (likely resume) — resetting watchdog`)
    pendingPing = null
    missedPongs = 0
    return
  }

  if (socket.readyState !== WebSocket.OPEN) return

  const transport = useTransportStore()
  // Not ready yet, or already recovering — don't probe or escalate; the
  // reconnect/recovery machinery owns those states.
  if (!transport.bridgeReady || transport.engineRecovery !== 'ok') return
  // During playback PLAYHEAD_UPDATE already proves message-thread liveness.
  if (transport.isPlaying) {
    pendingPing = null
    missedPongs = 0
    return
  }
  // A mixdown render can legitimately occupy the message thread; don't
  // mistake that for a hang.
  if (snapshotMixdownState()) {
    pendingPing = null
    missedPongs = 0
    return
  }
  // Library import / tempo + beat analysis is CPU-heavy work on the engine's
  // message thread that can legitimately stall PONG replies for several
  // seconds. Treat it like playback/mixdown: a known-busy engine is not a
  // hung engine, so suppress the probe rather than risk a false restart that
  // could interrupt the import.
  if (useLibraryStore().isImporting) {
    pendingPing = null
    missedPongs = 0
    return
  }

  // Resolve any outstanding ping first.
  if (pendingPing) {
    if (now - pendingPing.sentAt > WATCHDOG_PONG_TIMEOUT_MS) {
      missedPongs += 1
      pendingPing = null
      log.warn('perf.bridge', `PONG timeout (${missedPongs}/${WATCHDOG_MAX_MISSED})`)
      if (missedPongs >= WATCHDOG_MAX_MISSED) {
        missedPongs = 0
        engineRecovery.onEngineUnresponsive(`no PONG after ${WATCHDOG_MAX_MISSED} probes`)
      }
    }
    return
  }

  // Idle long enough? Send a fresh probe.
  const idleMs = lastInboundAt > 0 ? now - lastInboundAt : Number.POSITIVE_INFINITY
  if (idleMs >= WATCHDOG_IDLE_MS) {
    const id = ++pingNonce
    pendingPing = { id, sentAt: now }
    send('PING', { id })
  }
}

function stopSocketHeartbeat(): void {
  if (socketHeartbeat) {
    clearInterval(socketHeartbeat)
    socketHeartbeat = null
  }
  pendingPing = null
  missedPongs = 0
}

/**
 * Resolved bridge connection parameters: the WebSocket URL plus the
 * per-session AUTH token the renderer must send as its first envelope.
 * Both come from main via preload IPC; we resolve them once per session
 * and share the same in-flight promise across concurrent `connect()` calls.
 */
interface BridgeConnection {
  url: string
  token: string
}

let bridgeConnectionPromise: Promise<BridgeConnection> | null = null

function resolveBridgeConnection(): Promise<BridgeConnection> {
  if (bridgeConnectionPromise) return bridgeConnectionPromise
  const api = window.silverdaw
  const portPromise: Promise<number> =
    api && typeof api.getBridgePort === 'function'
      ? api.getBridgePort().catch((err) => {
          log.warn('bridge', `getBridgePort failed; falling back to default: ${String(err)}`)
          return DEFAULT_BRIDGE_PORT
        })
      : Promise.resolve(DEFAULT_BRIDGE_PORT)
  const tokenPromise: Promise<string> =
    api && typeof api.getBridgeToken === 'function'
      ? api.getBridgeToken().catch((err) => {
          // An empty token disables AUTH on the backend — only ever true in
          // stand-alone debug runs without `SILVERDAW_BRIDGE_TOKEN` set.
          log.warn('bridge', `getBridgeToken failed; sending empty token: ${String(err)}`)
          return ''
        })
      : Promise.resolve('')
  bridgeConnectionPromise = Promise.all([portPromise, tokenPromise]).then(([port, token]) => ({
    url: `ws://${BRIDGE_HOST}:${port}`,
    token
  }))
  return bridgeConnectionPromise
}

/** Open the connection. Safe to call multiple times. */
export function connect(): void {
  stopped = false
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }

  void resolveBridgeConnection().then((conn) => {
    // Bail if `disconnect()` ran between the resolve and the open.
    if (stopped) return
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    openSocket(conn)
  })
}

function openSocket(conn: BridgeConnection): void {
  const { url, token } = conn
  const ws = new WebSocket(url)
  socket = ws

  ws.addEventListener('open', () => {
    reconnectDelay = RECONNECT_DELAY_MS
    // Fresh socket — clear any stale liveness-probe state from the previous
    // connection so the watchdog starts from a clean slate.
    pendingPing = null
    missedPongs = 0
    lastInboundAt = performance.now()
    try {
      ws.send(JSON.stringify({ type: 'AUTH', payload: { token } }))
    } catch (err) {
      log.warn('bridge', `failed to send AUTH: ${String(err)}`)
    }
    useTransportStore().setConnected(true)
    log.info('bridge', `connected ${url}`)
    startSocketHeartbeat()
  })

  ws.addEventListener('close', () => {
    useTransportStore().setConnected(false)
    socket = null
    stopSocketHeartbeat()
    clearMasterLevels()
    clearTrackLevels()
    log.warn('bridge', 'socket closed')
    // An unexpected close mid-session means the engine dropped — kick off
    // the recovery flow (no-op until the engine has been ready once, and
    // skipped for the deliberate `disconnect()` teardown via `stopped`).
    if (!stopped) {
      engineRecovery.onConnectionLost()
      scheduleReconnect()
    }
  })

  ws.addEventListener('error', () => {
    log.error('bridge', 'socket error')
  })

  ws.addEventListener('message', (e) => {
    // Text-only protocol: see file header. Any binary frame here is a
    // protocol violation and is logged + dropped.
    if (typeof e.data !== 'string') {
      log.warn('bridge', 'unexpected non-text frame; dropping')
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(e.data)
    } catch (err) {
      log.warn('bridge', `failed to parse message: ${String(err)}`)
      return
    }
    const validated = validateInbound(raw)
    if (validated) dispatch(validated)
  })
}

/** Close the connection and stop reconnecting. */
export function disconnect(): void {
  stopped = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket) {
    socket.close()
    socket = null
  }
  useTransportStore().setConnected(false)
}

/** Send a typed command to the backend. Returns false when the socket is not connected. */
export function send<K extends BridgeOutboundType>(...args: BridgeOutboundArgs<K>): boolean {
  const [type, payload] = args as [K, unknown?]
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log.warn('bridge', `not connected; dropping ${type}`)
    return false
  }
  const env = payload === undefined ? { type } : { type, payload }
  outboundCount++
  // PLAYHEAD_UPDATE-style chatter doesn't exist outbound, but TRACK_GAIN
  // can fire per slider-pixel during a drag. Log everything except those
  // would-be high-frequency edges; for now, log every outbound envelope.
  if (type !== 'TRACK_GAIN') {
    log.info('bridge', `send ${type}`)
  } else {
    log.debug('bridge', `send ${type}`)
  }
  socket.send(JSON.stringify(env))
  return true
}

// ─── File-rate probe ────────────────────────────────────────────────────────
// `probeAudioFile()` issues an `AUDIO_FILE_PROBE` envelope and resolves
// when the backend responds with `AUDIO_FILE_PROBED`. Used by the
// import flow to read a source file's true sample rate (the renderer's
// Web Audio decode resamples to the AudioContext rate, which on
// Windows can lie about the source rate). `requestId` is a renderer-
// allocated string so concurrent probes from a batched import don't
// collide.

export type AudioFileProbeResult =
  | { ok: true; filePath: string; sampleRate: number; channelCount: number; durationMs: number }
  | { ok: false; filePath: string; error: string }

const pendingProbes = new Map<string, (result: AudioFileProbeResult) => void>()

let nextProbeId = 1

function resolveAudioFileProbe(payload: AudioFileProbedPayload): void {
  const resolver = pendingProbes.get(payload.requestId)
  if (payload.ok) {
    log.info(
      'probe',
      `result id=${payload.requestId} sampleRate=${payload.sampleRate}Hz ch=${payload.channelCount} duration=${payload.durationMs.toFixed(1)}ms path=${payload.filePath}`
    )
  } else {
    log.warn('probe', `failed id=${payload.requestId} path=${payload.filePath} error=${payload.error}`)
  }
  if (!resolver) return
  pendingProbes.delete(payload.requestId)
  if (payload.ok) {
    resolver({
      ok: true,
      filePath: payload.filePath,
      sampleRate: payload.sampleRate,
      channelCount: payload.channelCount,
      durationMs: payload.durationMs
    })
  } else {
    resolver({ ok: false, filePath: payload.filePath, error: payload.error })
  }
}

/**
 * Probe `filePath` and resolve with the file's true sample rate /
 * channel count / duration. Resolves to `{ ok: false, error }` when
 * the backend can't decode the file's header (missing, unsupported,
 * corrupt). Times out after 5 s if the backend never acks — the
 * resolved promise carries an error in that case rather than hanging
 * the import flow indefinitely.
 */
export function probeAudioFile(
  filePath: string,
  opts: { timeoutMs?: number } = {}
): Promise<AudioFileProbeResult> {
  const requestId = `probe-${nextProbeId++}-${Date.now().toString(36)}`
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 5000
    const timer = setTimeout(() => {
      if (pendingProbes.has(requestId)) {
        pendingProbes.delete(requestId)
        resolve({ ok: false, filePath, error: `probe timed out after ${timeoutMs}ms` })
      }
    }, timeoutMs)
    pendingProbes.set(requestId, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
    const sent = send('AUDIO_FILE_PROBE', { requestId, filePath })
    if (!sent) {
      clearTimeout(timer)
      pendingProbes.delete(requestId)
      resolve({ ok: false, filePath, error: 'backend not connected' })
    }
  })
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
    connect()
  }, reconnectDelay)
}

function dispatch(msg: BridgeInboundMessage): void {
  inboundCount++
  lastInboundAt = performance.now()
  // Exhaustive on `BridgeInboundType`: adding a new arm to `BridgeInboundMap`
  // without a matching case here is a TypeScript error via `assertNever`.
  // Skip PLAYHEAD_UPDATE — it fires 60 Hz and would drown the log. Same
  // for PREVIEW_POSITION while the editor dialog is open, and
  // MASTER_LEVEL which streams at the same cadence while audio is active.
  if (
    msg.type !== 'PLAYHEAD_UPDATE' &&
    msg.type !== 'PREVIEW_POSITION' &&
    msg.type !== 'MASTER_LEVEL' &&
    msg.type !== 'TRACK_LEVELS'
  ) {
    log.info('bridge', `recv ${msg.type}`)
  }
  switch (msg.type) {
    case 'READY':
      // Backend says hello; nothing to do yet.
      break

    case 'PROJECT_STATE': {
      // Backend-authoritative snapshot sent once per connection right
      // after AUTH. The renderer reconciles its optimistic state against
      // it — see `projectStore.applyProjectStateSnapshot` for semantics.
      useProjectStore().applyProjectStateSnapshot(msg.payload)
      useTransportStore().setPlaybackState(false)
      // Unblock the UI now that we have an authoritative snapshot and
      // the renderer's optimistic state is reconciled.
      useTransportStore().setBridgeReady(true)
      // Push to the Recent Projects MRU whenever a `reset=true` snapshot
      // arrives with a concrete file path — i.e. a successful Load or
      // Save As (the explicit-save path already runs through the
      // PROJECT_SAVED handler below, but Load does not, so without this
      // recently-opened-but-never-saved files never enter the MRU).
      // The initial AUTH-connect snapshot (no reset flag) is excluded so
      // we don't double-bump on every reconnect.
      if (msg.payload.reset === true && msg.payload.filePath) {
        window.silverdaw.setLastProjectPath(msg.payload.filePath)
        void useAppStore().refreshRecentProjects()
      }
      // First PROJECT_STATE = bridge is up. Seed the audio-device
      // mirror so the Preferences > Audio tab + the transport-bar
      // quick-switch render immediately rather than after the user
      // opens them.
      useAudioDeviceStore().requestInitialList()
      // Drive mid-session recovery: if we're mid-recovery this snapshot is
      // either the empty reconnect snapshot (→ kick re-load) or the
      // re-load's own reset snapshot (→ recovery complete).
      engineRecovery.onProjectStateApplied(msg.payload)
      break
    }

    case 'PLAYHEAD_UPDATE': {
      // Only mirror position — `isPlaying` is intentionally NOT taken
      // from this envelope. The backend's `PlayheadEmitter` runs at
      // 60 Hz and may have a tick in-flight when the user clicks
      // pause; honouring that stale `isPlaying=true` would flip the
      // optimistic local state back to "playing", desyncing the play
      // button (the next click then sends TRANSPORT_PAUSE on an
      // already-paused backend). Local intent is authoritative until
      // we add a dedicated TRANSPORT_STATE event for backend-driven
      // transitions (end-of-project auto-stop, error-pause, …).
      //
      // Squelch sample-rounding noise: when we optimistically set a
      // seek position (click on ruler, ←/→ arrow), the backend rounds
      // the ms to integer samples and reports back a value that's
      // typically < 0.05 ms different. Accepting that ack would snap
      // the visual playhead by a sub-pixel, which reads as flicker
      // under repeated arrow presses. Anything within 2 ms of the
      // local value is treated as "no new information" and dropped;
      // genuine playback advances (backend ticks 60 Hz → ~16 ms steps)
      // sail through this gate easily.
      const t = useTransportStore()
      if (Math.abs(msg.payload.positionMs - t.positionMs) < 2) break
      t.setPosition(msg.payload.positionMs)
      break
    }

    case 'CLIP_ADDED':
    case 'CLIP_ADD_FAILED': {
      // Reconcile the ack against the optimistically-added clip. On
      // failure the project store removes the clip and surfaces a toast
      // with the backend-supplied reason; on success it's a no-op.
      const project = useProjectStore()
      project.confirmClipAdd(
        msg.payload.trackId,
        msg.payload.clipId,
        msg.payload.ok,
        msg.payload.error
      )
      break
    }

    case 'TRACK_ADDED': {
      // The renderer optimistically created the track at request time;
      // a negative ack means the backend rejected (rare — addTrack is
      // idempotent on the backend). Diagnostic only.
      if (!msg.payload.ok) {
        log.warn('bridge', `TRACK_ADDED ok=false for ${msg.payload.trackId}`)
      }
      break
    }

    case 'TRACK_REMOVED': {
      // The renderer optimistically removed the track at request time. The
      // ack is purely diagnostic: a negative ack means our view drifted
      // out of sync with the backend (unknown trackId on the engine side).
      if (!msg.payload.ok) {
        log.warn('bridge', `TRACK_REMOVED ok=false for ${msg.payload.trackId}`)
      }
      break
    }

    case 'CLIP_REMOVED': {
      // Optimistic clip removal already happened on the renderer when
      // we sent CLIP_REMOVE; this ack just confirms the backend dropped
      // it too. ok=false means the id was unknown — a diagnostic.
      if (!msg.payload.ok) {
        log.warn('bridge', `CLIP_REMOVED ok=false for ${msg.payload.clipId}`)
      }
      break
    }

    case 'TRACK_GAIN_APPLIED': {
      // Same shape as TRACK_REMOVED: optimistic update already happened
      // on commit; the ack just confirms the engine accepted it. A
      // negative ack means the trackId was unknown on the backend.
      if (!msg.payload.ok) {
        log.warn(
          'bridge',
          `TRACK_GAIN_APPLIED ok=false for ${msg.payload.trackId} gain=${msg.payload.gain}`
        )
      }
      break
    }

    case 'TRACK_MUTE_APPLIED': {
      if (!msg.payload.ok) {
        log.warn('bridge',
          `TRACK_MUTE_APPLIED ok=false for ${msg.payload.trackId} muted=${msg.payload.muted}`)
      }
      break
    }

    case 'TRACK_SOLO_APPLIED': {
      if (!msg.payload.ok) {
        log.warn('bridge',
          `TRACK_SOLO_APPLIED ok=false for ${msg.payload.trackId} soloed=${msg.payload.soloed}`)
      }
      break
    }

    case 'PROJECT_SAVED': {
      const notifications = useNotificationsStore()
      const project = useProjectStore()
      // Resolve any outstanding saveAndWait Promise so the
      // unsaved-changes flow in App.vue can proceed.
      project.notifySaveAck(msg.payload.ok, msg.payload.error)
      if (msg.payload.ok) {
        log.info('bridge', `PROJECT_SAVED path=${msg.payload.filePath}`)
        // Persist the path as "last project" so the next launch reopens
        // it. Main owns the preferences file and ignores empty values.
        // `project:setLastPath` also bumps the Recent Projects MRU.
        window.silverdaw.setLastProjectPath(msg.payload.filePath)
        // The explicit save made the autosave bucket redundant — drop it
        // so the next launch's recovery scan stays clean. Use the
        // current project id (post-save the id may have rotated if this
        // was a Save As; both old and new ids get cleared because the
        // store's previousProjectId watcher in `autosave.ts` deletes the
        // old bucket on the reset=true PROJECT_STATE that follows).
        if (project.projectId) void window.silverdaw.clearAutosave(project.projectId)
        // Refresh the in-store MRU mirror so the File menu picks up the
        // new top entry without waiting for a re-launch.
        void useAppStore().refreshRecentProjects()
        notifications.pushInfo('Project saved')
      } else {
        log.warn('bridge', `PROJECT_SAVED failed: ${msg.payload.error ?? 'unknown'}`)
        notifications.pushError(`Save failed: ${msg.payload.error ?? 'unknown error'}`)
      }
      break
    }

    case 'PROJECT_VIEW_STATE_SAVED': {
      useProjectStore().notifyViewStateSaveAck(msg.payload.ok, msg.payload.error)
      if (!msg.payload.ok) {
        log.warn('bridge', `PROJECT_VIEW_STATE_SAVED failed: ${msg.payload.error ?? 'unknown'}`)
      }
      break
    }

    case 'PROJECT_AUTOSAVED': {
      // Autosave is intentionally invisible at the user level — no
      // toast, no PROJECT_STATE follow-up. The renderer's autosave
      // manager listens for this ack to advance the manifest from
      // "pending" to confirmed so crash recovery picks the entry up.
      useProjectStore().notifyAutosaveAck(msg.payload.filePath, msg.payload.ok, msg.payload.error)
      if (!msg.payload.ok) {
        log.warn('bridge', `PROJECT_AUTOSAVED failed: ${msg.payload.error ?? 'unknown'}`)
      } else {
        log.debug('bridge', `PROJECT_AUTOSAVED path=${msg.payload.filePath}`)
      }
      break
    }

    case 'PROJECT_LOAD_FAILED': {
      log.warn('bridge', `PROJECT_LOAD_FAILED ${msg.payload.filePath}: ${msg.payload.error}`)
      useProjectStore().notifyProjectLoadFailed(msg.payload.error)
      useNotificationsStore().pushError(
        `Could not open project: ${msg.payload.error || msg.payload.filePath}`
      )
      // The MRU's `openRecentPath` helper already prunes missing /
      // unreadable entries on click, so there's nothing else to do
      // here — the user picked a file, the backend rejected it, the
      // toast surfaces why.
      break
    }

    case 'PROJECT_RENAMED': {
      // Renderer already updated `projectName` optimistically in
      // `requestRename`; this ack just confirms the backend stored the
      // value. Mirror back in case the backend canonicalised (e.g.
      // trimmed whitespace) the input.
      if (msg.payload.ok) {
        useProjectStore().projectName = msg.payload.name
      }
      break
    }

    case 'PROJECT_DIRTY': {
      useProjectStore().isDirty = msg.payload.dirty
      log.debug('bridge', `PROJECT_DIRTY dirty=${msg.payload.dirty}`)
      break
    }

    case 'WAVEFORM_READY': {
      // Backend has finished writing the peaks cache file. Pull the
      // bytes from disk via main's IPC and dequantise into the project
      // store. Bulk data deliberately bypasses the WebSocket — see
      // file header for the rationale.
      void loadPeaksFromCache(msg.payload)
      break
    }

    case 'CLIP_EDITOR_PEAKS_READY': {
      // High-resolution peaks for the Clip Editor — same wire model
      // as WAVEFORM_READY but keyed on the library item id so all
      // saved-clips that share the source can reuse one cache entry.
      void loadEditorPeaksFromCache(msg.payload)
      break
    }

    case 'LIBRARY_ITEM_ANALYSIS': {
      useLibraryStore().setItemAnalysis(
        msg.payload.itemId,
        msg.payload.bpm,
        msg.payload.beatAnchorSec,
        msg.payload.beats,
        msg.payload.variableTempo,
        msg.payload.playbackFilePath,
        msg.payload.lowConfidence
      )
      log.info(
        'bridge',
        `LIBRARY_ITEM_ANALYSIS itemId=${msg.payload.itemId} bpm=${msg.payload.bpm.toFixed(2)} anchor=${msg.payload.beatAnchorSec.toFixed(3)}s beats=${msg.payload.beats.length}${msg.payload.variableTempo ? ' variable' : ''}${msg.payload.lowConfidence ? ' low-confidence' : ''}${msg.payload.playbackFilePath ? ' (cached)' : ''}`
      )
      break
    }

    case 'PROJECT_BPM_APPLIED': {
      // Backend seeded the project BPM (typically from the first
      // import). Mirror locally — transportStore.setBpm is local-only,
      // so no echo back to the bridge.
      useTransportStore().setBpm(msg.payload.bpm)
      log.info('bridge', `PROJECT_BPM_APPLIED bpm=${msg.payload.bpm.toFixed(2)}`)
      break
    }

    case 'CLIP_WARP_APPLIED': {
      // Backend flipped or adjusted warp server-side (e.g. late
      // auto-warp after LIBRARY_ITEM_ANALYSIS). Mirror locally without
      // echoing CLIP_SET_WARP back to the backend.
      const project = useProjectStore()
      project.setClipWarp(
        msg.payload.clipId,
        {
          warpEnabled: msg.payload.warpEnabled,
          warpMode: msg.payload.warpMode,
          tempoRatio: msg.payload.tempoRatio,
          semitones: msg.payload.semitones,
          cents: msg.payload.cents,
          pendingAutoWarp: msg.payload.pendingAutoWarp,
          effectiveDurationMs: msg.payload.effectiveDurationMs,
          effectiveTempoRatio: msg.payload.effectiveTempoRatio,
          effectiveWarpActive: msg.payload.effectiveWarpActive
        },
        { localOnly: true }
      )
      const clip = project.clips[msg.payload.clipId]
      if (clip) useLibraryStore().finishItemWarping(clip.libraryItemId)
      log.info('bridge', `CLIP_WARP_APPLIED clipId=${msg.payload.clipId}`)
      break
    }

    case 'SAMPLE_SAVED': {
      void applySampleSaved(msg.payload)
      break
    }

    case 'PREVIEW_STATE': {
      usePreviewStore().applyState(msg.payload)
      break
    }

    case 'PREVIEW_POSITION': {
      usePreviewStore().applyPosition(msg.payload)
      break
    }

    case 'PREVIEW_ENDED': {
      usePreviewStore().applyEnded(msg.payload)
      break
    }

    case 'AUDIO_DEVICES_LIST': {
      useAudioDeviceStore().applyList(msg.payload)
      break
    }

    case 'AUDIO_DEVICE_CHANGED': {
      useAudioDeviceStore().applyChanged(msg.payload)
      break
    }

    case 'EDIT_UNDO_STATE': {
      useProjectStore().applyEditUndoState(msg.payload)
      break
    }

    case 'AUDIO_FILE_PROBED': {
      // Resolve the pending `probeAudioFile()` promise keyed by
      // `requestId`. Late acks for promises that have already been
      // resolved (or whose initiator was cancelled) are dropped on
      // the floor — there is no harm in a missing entry.
      resolveAudioFileProbe(msg.payload)
      break
    }

    case 'MIXDOWN_PROGRESS': {
      applyMixdownProgress(msg.payload)
      break
    }

    case 'MIXDOWN_DONE': {
      const tracked = snapshotMixdownState()
      clearMixdownState()
      const fileName = msg.payload.filePath.replace(/^.*[\\/]/, '')
      useNotificationsStore().pushInfo(`Exported ${fileName}`)
      log.info('mixdown', `done filePath=${msg.payload.filePath} durationMs=${msg.payload.durationMs} (tracked format=${tracked?.format ?? 'unknown'})`)
      break
    }

    case 'MIXDOWN_FAILED': {
      const tracked = snapshotMixdownState()
      clearMixdownState()
      if (msg.payload.code === 'cancelled') {
        useNotificationsStore().pushInfo('Mixdown cancelled')
        log.info('mixdown', `cancelled (tracked path=${tracked?.outputPath ?? 'unknown'})`)
      } else {
        useNotificationsStore().pushError(`Mixdown failed: ${msg.payload.error}`)
        log.error('mixdown', `failed code=${msg.payload.code} error=${msg.payload.error}`)
      }
      break
    }

    case 'MASTER_LEVEL': {
      // Push the peaks into the non-reactive level channel — the
      // `MasterMeter` component reads them on its RAF loop, so we
      // intentionally avoid touching a Pinia store here (which would
      // fan out a re-render to every subscriber 60x/s).
      setMasterLevels(msg.payload.peakL, msg.payload.peakR)
      break
    }

    case 'TRACK_LEVELS': {
      // Same rationale as MASTER_LEVEL: peaks land in a non-reactive
      // channel and per-track `TrackMeter` components poll on their
      // shared RAF loop.
      setTrackLevels(msg.payload.tracks)
      break
    }

    // ─── Phase 5 FX deltas. The bridge layer just acknowledges the
    //     envelope shape; the actual store mutations land per-feature
    //     when the renderer-side UI for each effect ships. Until then
    //     PROJECT_STATE refreshes (on save / load / undo) carry the
    //     persisted values, so dropping the deltas here is harmless.
    case 'TRACK_TONE_APPLIED': {
      // Reconcile to the backend-canonical (clamped / default-suppressed)
      // Tone values without echoing the gesture back to the engine.
      if (!msg.payload.ok) {
        log.warn('bridge', `TRACK_TONE_APPLIED ok=false for ${msg.payload.trackId}`)
        break
      }
      useProjectStore().setTrackTone(
        msg.payload.trackId,
        {
          bassDb: msg.payload.bassDb,
          midDb: msg.payload.midDb,
          trebleDb: msg.payload.trebleDb,
          lowCut: msg.payload.lowCut,
          highCut: msg.payload.highCut
        },
        { localOnly: true }
      )
      break
    }

    case 'TRACK_SENDS_APPLIED': {
      if (!msg.payload.ok) {
        log.warn('bridge', `TRACK_SENDS_APPLIED ok=false for ${msg.payload.trackId}`)
        break
      }
      useProjectStore().setTrackSends(
        msg.payload.trackId,
        { reverbSend: msg.payload.reverbSend, delaySend: msg.payload.delaySend },
        { localOnly: true }
      )
      break
    }

    case 'TRACK_PAN_APPLIED': {
      if (!msg.payload.ok) {
        log.warn('bridge', `TRACK_PAN_APPLIED ok=false for ${msg.payload.trackId}`)
        break
      }
      useProjectStore().setTrackPan(msg.payload.trackId, msg.payload.pan, { localOnly: true })
      break
    }

    case 'PROJECT_REVERB_APPLIED': {
      if (!msg.payload.ok) {
        log.warn('bridge', 'PROJECT_REVERB_APPLIED ok=false')
        break
      }
      useProjectStore().setProjectReverb(
        {
          size: msg.payload.size,
          decay: msg.payload.decay,
          tone: msg.payload.tone,
          mix: msg.payload.mix
        },
        { localOnly: true }
      )
      break
    }

    case 'PROJECT_DELAY_APPLIED': {
      if (!msg.payload.ok) {
        log.warn('bridge', 'PROJECT_DELAY_APPLIED ok=false')
        break
      }
      useProjectStore().setProjectDelay(
        {
          noteValue: msg.payload.noteValue,
          feedback: msg.payload.feedback,
          tone: msg.payload.tone,
          mix: msg.payload.mix
        },
        { localOnly: true }
      )
      break
    }

    case 'TRACK_LEVELER_APPLIED': {
      if (!msg.payload.ok) {
        log.warn('bridge', `TRACK_LEVELER_APPLIED ok=false for ${msg.payload.trackId}`)
        break
      }
      useProjectStore().setTrackLeveler(msg.payload.trackId, msg.payload.amount, {
        localOnly: true
      })
      break
    }

    case 'CLIP_ENVELOPE_APPLIED': {
      // Mirror the backend-normalised volume-shape breakpoints into the
      // local clip so undo / redo / cross-renderer ACKs flow without
      // waiting for a full PROJECT_STATE. An empty array clears the shape.
      useProjectStore().setClipEnvelope(
        msg.payload.clipId,
        msg.payload.points ?? [],
        { localOnly: true }
      )
      log.info('bridge', `CLIP_ENVELOPE_APPLIED clipId=${msg.payload.clipId} points=${msg.payload.points?.length ?? 0}`)
      break
    }

    case 'PONG': {
      // Liveness reply. Clear the matching outstanding probe and reset the
      // miss counter — the engine's message thread is alive.
      if (pendingPing && pendingPing.id === msg.payload.id) {
        pendingPing = null
      }
      missedPongs = 0
      break
    }

    case 'ENGINE_ERROR': {
      // The backend caught (and survived) an exception in a handler. Surface
      // it honestly but non-fatally — the engine is still running.
      log.error('bridge', `ENGINE_ERROR: ${msg.payload.message}`)
      useNotificationsStore().pushError(
        'The audio engine hit a problem but kept running. If something looks off, try the action again.',
        8000
      )
      break
    }

    default:
      assertNever(msg)
  }
}
