// WebSocket bridge to the JUCE backend: dynamic port, AUTH-first JSON envelopes, reconnect.
// The shared protocol constrains `send()` and inbound validation before stores see data.
// Bulk payloads stay on disk; the socket is the control plane.
//
// File-size exception: connection lifecycle, watchdog, probes, and exhaustive dispatch share
// socket/timer/counter state. Independent peaks and validation concerns are already extracted;
// split only future self-contained concerns instead of inventing a shared-state wrapper.

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
// Idle sessions need PING/PONG to prove the engine message thread still responds.
const WATCHDOG_INTERVAL_MS = 1000
/** Quiet period (no inbound) before we start actively pinging. */
const WATCHDOG_IDLE_MS = 3000
/** How long to wait for a PONG before counting it as missed. */
const WATCHDOG_PONG_TIMEOUT_MS = 2000
/** Consecutive missed PONGs that declare the engine hung. */
const WATCHDOG_MAX_MISSED = 3
/** Tick gap beyond this implies the machine slept — treat as resume. */
const WATCHDOG_DRIFT_MS = 4000

let socket: WebSocket | null = null
let reconnectDelay = RECONNECT_DELAY_MS
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false
let socketHeartbeat: ReturnType<typeof setInterval> | null = null
let outboundCount = 0
let inboundCount = 0
let lastInboundAt = 0
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

/** Probe idle engine liveness and escalate after repeated missed PONGs. */
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

  // Sleep/resume drift can create false PONG misses; reset and re-evaluate.
  if (driftMs > WATCHDOG_DRIFT_MS) {
    log.info('perf.bridge', `clock drift ${driftMs.toFixed(0)}ms (likely resume) — resetting watchdog`)
    pendingPing = null
    missedPongs = 0
    return
  }

  if (socket.readyState !== WebSocket.OPEN) return

  const transport = useTransportStore()
  // Reconnect/recovery owns non-ready states.
  if (!transport.bridgeReady || transport.engineRecovery !== 'ok') return
  if (transport.isPlaying) {
    pendingPing = null
    missedPongs = 0
    return
  }
  // Mixdown can legitimately occupy the message thread.
  if (snapshotMixdownState()) {
    pendingPing = null
    missedPongs = 0
    return
  }
  // Import/analysis can stall PONG replies without meaning the engine is hung.
  if (useLibraryStore().isImporting) {
    pendingPing = null
    missedPongs = 0
    return
  }

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

/** Resolved URL plus AUTH token; concurrent `connect()` calls share one promise. */
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
          // Empty token is for stand-alone debug runs only.
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

export function connect(): void {
  stopped = false
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }

  void resolveBridgeConnection().then((conn) => {
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
    // Fresh socket: reset liveness state before AUTH.
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
    // Unexpected close starts mid-session recovery, then reconnects.
    if (!stopped) {
      engineRecovery.onConnectionLost()
      scheduleReconnect()
    }
  })

  ws.addEventListener('error', () => {
    log.error('bridge', 'socket error')
  })

  ws.addEventListener('message', (e) => {
    // Binary frames violate the text-only protocol.
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
  // TRACK_GAIN can fire per slider pixel; keep it at debug.
  if (type !== 'TRACK_GAIN') {
    log.info('bridge', `send ${type}`)
  } else {
    log.debug('bridge', `send ${type}`)
  }
  socket.send(JSON.stringify(env))
  return true
}

// ─── File-rate probe ────────────────────────────────────────────────────────
// True source rates come from backend probes because Web Audio may resample.

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

/** Probe true file rate/channel/duration; timeout returns `{ ok: false }`. */
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
  // Exhaustive via `assertNever`; suppress high-frequency inbound logs.
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
      break

    case 'PROJECT_STATE': {
      // Authoritative snapshot after AUTH reconciles optimistic state.
      useProjectStore().applyProjectStateSnapshot(msg.payload)
      useTransportStore().setPlaybackState(false)
      useTransportStore().setBridgeReady(true)
      // Load/Save As reset snapshots update MRU; initial reconnect snapshots do not.
      if (msg.payload.reset === true && msg.payload.filePath) {
        window.silverdaw.setLastProjectPath(msg.payload.filePath)
        void useAppStore().refreshRecentProjects()
      }
      // Seed audio devices as soon as the bridge is ready.
      useAudioDeviceStore().requestInitialList()
      // Recovery distinguishes empty reconnect snapshots from restored resets.
      engineRecovery.onProjectStateApplied(msg.payload)
      break
    }

    case 'PLAYHEAD_UPDATE': {
      // Position only: local play intent wins, and <2 ms sample-rounding acks are ignored.
      const t = useTransportStore()
      if (Math.abs(msg.payload.positionMs - t.positionMs) < 2) break
      t.setPosition(msg.payload.positionMs)
      break
    }

    case 'CLIP_ADDED':
    case 'CLIP_ADD_FAILED': {
      // Reconcile optimistic clip add; failures remove and toast.
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
      // Diagnostic only: track was already created optimistically.
      if (!msg.payload.ok) {
        log.warn('bridge', `TRACK_ADDED ok=false for ${msg.payload.trackId}`)
      }
      break
    }

    case 'TRACK_REMOVED': {
      // Diagnostic only: track was already removed optimistically.
      if (!msg.payload.ok) {
        log.warn('bridge', `TRACK_REMOVED ok=false for ${msg.payload.trackId}`)
      }
      break
    }

    case 'CLIP_REMOVED': {
      // Diagnostic only: clip was already removed optimistically.
      if (!msg.payload.ok) {
        log.warn('bridge', `CLIP_REMOVED ok=false for ${msg.payload.clipId}`)
      }
      break
    }

    case 'TRACK_GAIN_APPLIED': {
      // Diagnostic only: gain was already applied optimistically.
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
      // Unblock any saveAndWait caller.
      project.notifySaveAck(msg.payload.ok, msg.payload.error)
      if (msg.payload.ok) {
        log.info('bridge', `PROJECT_SAVED path=${msg.payload.filePath}`)
        // Main persists last project path and updates the MRU.
        window.silverdaw.setLastProjectPath(msg.payload.filePath)
        // Explicit save makes the current autosave bucket redundant.
        if (project.projectId) void window.silverdaw.clearAutosave(project.projectId)
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
      // Autosave acks confirm pending manifests without user-visible UI.
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
      break
    }

    case 'PROJECT_RENAMED': {
      // Mirror backend-canonical name after optimistic rename.
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
      // Bulk peaks stay on disk; main reads and dequantises them.
      void loadPeaksFromCache(msg.payload)
      break
    }

    case 'CLIP_EDITOR_PEAKS_READY': {
      // Clip Editor peaks are keyed by library item for saved-clip reuse.
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
      // Mirror backend-seeded BPM locally without echoing to the bridge.
      useTransportStore().setBpm(msg.payload.bpm)
      log.info('bridge', `PROJECT_BPM_APPLIED bpm=${msg.payload.bpm.toFixed(2)}`)
      break
    }

    case 'CLIP_WARP_APPLIED': {
      // Mirror backend warp changes locally without echoing.
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
      // Resolve by `requestId`; late or cancelled probe acks are harmless.
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
      // Non-reactive meter channel avoids 60 Hz Pinia fan-out.
      setMasterLevels(msg.payload.peakL, msg.payload.peakR)
      break
    }

    case 'TRACK_LEVELS': {
      // Same non-reactive meter channel as MASTER_LEVEL.
      setTrackLevels(msg.payload.tracks)
      break
    }

    case 'TRACK_TONE_APPLIED': {
      // Apply backend-canonical values without echoing.
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
      // Mirror backend-normalised envelope points without waiting for PROJECT_STATE.
      useProjectStore().setClipEnvelope(
        msg.payload.clipId,
        msg.payload.points ?? [],
        { localOnly: true }
      )
      log.info('bridge', `CLIP_ENVELOPE_APPLIED clipId=${msg.payload.clipId} points=${msg.payload.points?.length ?? 0}`)
      break
    }

    case 'PONG': {
      // Liveness reply from the engine message thread.
      if (pendingPing && pendingPing.id === msg.payload.id) {
        pendingPing = null
      }
      missedPongs = 0
      break
    }

    case 'ENGINE_ERROR': {
      // Backend survived a handler exception; surface it non-fatally.
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
