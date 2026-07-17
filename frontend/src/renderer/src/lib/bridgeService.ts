// WebSocket bridge to the JUCE backend: dynamic port, AUTH-first JSON envelopes, reconnect.
// The shared protocol constrains `send()` and inbound validation before stores see data.
// Bulk payloads stay on disk; the socket is the control plane.
//
// Per-type inbound handling lives in domain-grouped maps under `bridge/handlers/`;
// this module owns connection lifecycle, the liveness watchdog, file-rate probes, and
// the merged dispatch. Liveness/probe handlers stay here because they touch socket/
// timer/probe state that is intentionally module-private.

import { useTransportStore } from '@/stores/transportStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { snapshotMixdownState } from '@/lib/mixdownState'
import { clearMasterLevels } from '@/lib/audio/masterLevelChannel'
import { clearTrackLevels } from '@/lib/audio/trackLevelsChannel'
import * as engineRecovery from '@/lib/engineRecovery'
import { log } from '@/lib/log'
import {
  type AudioFileProbedPayload,
  type BridgeInboundMessage,
  type BridgeOutboundArgs,
  type BridgeOutboundType
} from '@shared/bridge-protocol'

import { validateInbound } from '@/lib/bridge/inboundValidation'
import { validateOutboundEnvelope } from '@/lib/bridge/outboundValidation'
import { BridgeReconnectPolicy } from '@/lib/bridgeReconnectPolicy'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'
import { transportBridgeHandlers } from '@/lib/bridge/handlers/transportHandlers'
import { projectBridgeHandlers } from '@/lib/bridge/handlers/projectHandlers'
import { trackClipBridgeHandlers } from '@/lib/bridge/handlers/trackClipHandlers'
import { libraryBridgeHandlers } from '@/lib/bridge/handlers/libraryHandlers'
import { previewBridgeHandlers } from '@/lib/bridge/handlers/previewHandlers'
import { audioDeviceBridgeHandlers } from '@/lib/bridge/handlers/audioDeviceHandlers'
import { midiDeviceBridgeHandlers } from '@/lib/bridge/handlers/midiDeviceHandlers'
import { scratchSessionBridgeHandlers } from '@/lib/bridge/handlers/scratchSessionHandlers'
import { mixdownBridgeHandlers } from '@/lib/bridge/handlers/mixdownHandlers'
import { stemBridgeHandlers } from '@/lib/bridge/handlers/stemHandlers'
import { channelSplitBridgeHandlers } from '@/lib/bridge/handlers/channelSplitHandlers'
import { meterBridgeHandlers } from '@/lib/bridge/handlers/meterHandlers'

const BRIDGE_HOST = '127.0.0.1'
const DEFAULT_BRIDGE_PORT = 8765

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
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const reconnectPolicy = new BridgeReconnectPolicy()
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
    reconnectPolicy.markConnected()
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
  reconnectPolicy.reset()
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
  const check = validateOutboundEnvelope(type, payload)
  if (!check.ok) {
    log.error('bridge', `refusing to send malformed envelope: ${check.reason}`)
    return false
  }
  const env = payload === undefined ? { type } : { type, payload }
  let serialised: string
  try {
    serialised = JSON.stringify(env)
  } catch (err) {
    log.error('bridge', `failed to serialise ${type}: ${String(err)}`)
    return false
  }
  outboundCount++
  // High-rate controls are coalesced by their UI surfaces, but still send up to
  // one message per frame. Scratch session control logging is omitted entirely:
  // every renderer log level is batched over IPC, which can otherwise starve
  // pointer and keyboard input while a platter or crossfader is moving.
  if (type !== 'SCRATCH_SESSION_CONTROL') {
    if (type !== 'TRACK_GAIN') {
      log.info('bridge', `send ${type}`)
    } else {
      log.debug('bridge', `send ${type}`)
    }
  }
  socket.send(serialised)
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
  const delayMs = reconnectPolicy.nextDelayMs()
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delayMs)
}

// Domain-grouped handlers replace a hand-maintained switch. The merged literal is
// checked against the full inbound union (`satisfies`), so the compiler flags any
// uncovered message type. Liveness/probe handlers stay local: they touch socket,
// watchdog, and probe state that is intentionally module-private.
const livenessBridgeHandlers: BridgeInboundHandlers<'PONG' | 'AUDIO_FILE_PROBED'> = {
  PONG: (payload) => {
    // Liveness reply from the engine message thread.
    if (pendingPing && pendingPing.id === payload.id) {
      pendingPing = null
    }
    missedPongs = 0
  },

  AUDIO_FILE_PROBED: (payload) => {
    // Resolve by `requestId`; late or cancelled probe acks are harmless.
    resolveAudioFileProbe(payload)
  }
}

const inboundHandlers = {
  // Domain subsets must stay disjoint: duplicate keys would silently last-win across spreads.
  ...transportBridgeHandlers,
  ...projectBridgeHandlers,
  ...trackClipBridgeHandlers,
  ...libraryBridgeHandlers,
  ...previewBridgeHandlers,
  ...audioDeviceBridgeHandlers,
  ...midiDeviceBridgeHandlers,
  ...scratchSessionBridgeHandlers,
  ...mixdownBridgeHandlers,
  ...stemBridgeHandlers,
  ...channelSplitBridgeHandlers,
  ...meterBridgeHandlers,
  ...livenessBridgeHandlers
} satisfies BridgeInboundHandlers

function dispatch(msg: BridgeInboundMessage): void {
  inboundCount++
  lastInboundAt = performance.now()
  // Suppress high-frequency inbound logs.
  if (
    msg.type !== 'PLAYHEAD_UPDATE' &&
    msg.type !== 'PREVIEW_POSITION' &&
    msg.type !== 'MASTER_LEVEL' &&
    msg.type !== 'TRACK_LEVELS' &&
    msg.type !== 'MIDI_CONTROL'
  ) {
    log.info('bridge', `recv ${msg.type}`)
  }
  const handler = inboundHandlers[msg.type]
  if (!handler) {
    // Defensive: validateInbound rejects unknown types upstream, so this is drift insurance.
    log.warn('bridge', `no handler for inbound type ${msg.type}`)
    return
  }
  // `msg` is a discriminated union, so the handler and payload are correlated at
  // runtime; the cast only bridges what TS cannot prove across the keyed lookup.
  ;(handler as (payload: typeof msg.payload) => void)(msg.payload)
}
