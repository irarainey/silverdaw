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

import { useTransportStore } from '@/stores/transportStore'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import {
  isBridgeInboundType,
  isClipAckPayload,
  isClipRemovedPayload,
  isLibraryItemBpmPayload,
  isPlayheadUpdatePayload,
  isProjectBpmAppliedPayload,
  isProjectDirtyPayload,
  isProjectLoadFailedPayload,
  isProjectRenamedPayload,
  isProjectSavedPayload,
  isProjectStatePayload,
  isReadyPayload,
  isTrackAddedPayload,
  isTrackGainAppliedPayload,
  isTrackRemovedPayload,
  isWaveformReadyPayload,
  type BridgeInboundMessage,
  type BridgeInboundType,
  type BridgeOutboundArgs,
  type BridgeOutboundType,
  type WaveformReadyPayload
} from '@shared/bridge-protocol'

const BRIDGE_HOST = '127.0.0.1'
const DEFAULT_BRIDGE_PORT = 8765
const RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 5000

/** Raw `{type, payload}` envelope as it arrives off the wire (pre-validation). */
interface RawBridgeEnvelope {
  type?: unknown
  payload?: unknown
}

let socket: WebSocket | null = null
let reconnectDelay = RECONNECT_DELAY_MS
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false
let socketHeartbeat: ReturnType<typeof setInterval> | null = null

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
  socketHeartbeat = setInterval(() => {
    if (!socket) return
    log.debug(
      'bridge',
      `heartbeat readyState=${readyStateName(socket.readyState)} bufferedAmount=${socket.bufferedAmount}`
    )
  }, 2000)
}

function stopSocketHeartbeat(): void {
  if (socketHeartbeat) {
    clearInterval(socketHeartbeat)
    socketHeartbeat = null
  }
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
          console.warn('[bridge] getBridgePort failed; falling back to default', err)
          return DEFAULT_BRIDGE_PORT
        })
      : Promise.resolve(DEFAULT_BRIDGE_PORT)
  const tokenPromise: Promise<string> =
    api && typeof api.getBridgeToken === 'function'
      ? api.getBridgeToken().catch((err) => {
          // An empty token disables AUTH on the backend — only ever true in
          // stand-alone debug runs without `SILVERDAW_BRIDGE_TOKEN` set.
          console.warn('[bridge] getBridgeToken failed; sending empty token', err)
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
    try {
      ws.send(JSON.stringify({ type: 'AUTH', payload: { token } }))
    } catch (err) {
      console.warn('[bridge] failed to send AUTH envelope', err)
      log.warn('bridge', `failed to send AUTH: ${String(err)}`)
    }
    useTransportStore().setConnected(true)
    log.info('bridge', `connected ${url}`)
    startSocketHeartbeat()
    console.log('[bridge] connected', url)
  })

  ws.addEventListener('close', () => {
    useTransportStore().setConnected(false)
    socket = null
    stopSocketHeartbeat()
    log.warn('bridge', 'socket closed')
    if (!stopped) scheduleReconnect()
  })

  ws.addEventListener('error', (e) => {
    console.warn('[bridge] socket error', e)
    log.error('bridge', 'socket error')
  })

  ws.addEventListener('message', (e) => {
    // Text-only protocol: see file header. Any binary frame here is a
    // protocol violation and is logged + dropped.
    if (typeof e.data !== 'string') {
      console.warn('[bridge] unexpected non-text frame; dropping', e.data)
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(e.data)
    } catch (err) {
      console.warn('[bridge] failed to parse message', err, e.data)
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

/** Send a typed command to the backend. Drops silently if not connected. */
export function send<K extends BridgeOutboundType>(...args: BridgeOutboundArgs<K>): void {
  const [type, payload] = args as [K, unknown?]
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn('[bridge] not connected; dropping', type)
    log.warn('bridge', `not connected; dropping ${type}`)
    return
  }
  const env = payload === undefined ? { type } : { type, payload }
  // PLAYHEAD_UPDATE-style chatter doesn't exist outbound, but TRACK_GAIN
  // can fire per slider-pixel during a drag. Log everything except those
  // would-be high-frequency edges; for now, log every outbound envelope.
  if (type !== 'TRACK_GAIN') {
    log.info('bridge', `send ${type}`)
  } else {
    log.debug('bridge', `send ${type}`)
  }
  socket.send(JSON.stringify(env))
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
  // Exhaustive on `BridgeInboundType`: adding a new arm to `BridgeInboundMap`
  // without a matching case here is a TypeScript error via `assertNever`.
  // Skip PLAYHEAD_UPDATE — it fires 60 Hz and would drown the log.
  if (msg.type !== 'PLAYHEAD_UPDATE') {
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
      // The backend's master clock is persistent across renderer reloads
      // (the JUCE process keeps running). Without this, a renderer Ctrl-R
      // would rejoin at whatever position the backend was last at —
      // confusing because the user expects a reload to "start fresh".
      // Reset locally first so the UI snaps to 0 immediately, then ask
      // the backend to zero its master clock so subsequent
      // PLAYHEAD_UPDATEs agree.
      const t = useTransportStore()
      t.setPlaybackState(false, 0)
      send('TRANSPORT_STOP')
      // Unblock the UI now that we have an authoritative snapshot and
      // the renderer's optimistic state is reconciled.
      t.setBridgeReady(true)
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
        console.warn('[bridge] TRACK_ADDED ok=false for', msg.payload.trackId)
      }
      break
    }

    case 'TRACK_REMOVED': {
      // The renderer optimistically removed the track at request time. The
      // ack is purely diagnostic: a negative ack means our view drifted
      // out of sync with the backend (unknown trackId on the engine side).
      if (!msg.payload.ok) {
        console.warn('[bridge] TRACK_REMOVED ok=false for', msg.payload.trackId)
      }
      break
    }

    case 'CLIP_REMOVED': {
      // Optimistic clip removal already happened on the renderer when
      // we sent CLIP_REMOVE; this ack just confirms the backend dropped
      // it too. ok=false means the id was unknown — a diagnostic.
      if (!msg.payload.ok) {
        console.warn('[bridge] CLIP_REMOVED ok=false for', msg.payload.clipId)
      }
      break
    }

    case 'TRACK_GAIN_APPLIED': {
      // Same shape as TRACK_REMOVED: optimistic update already happened
      // on commit; the ack just confirms the engine accepted it. A
      // negative ack means the trackId was unknown on the backend.
      if (!msg.payload.ok) {
        console.warn(
          '[bridge] TRACK_GAIN_APPLIED ok=false for',
          msg.payload.trackId,
          'gain=',
          msg.payload.gain
        )
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
        window.silverdaw.setLastProjectPath(msg.payload.filePath)
        notifications.pushInfo('Project saved')
      } else {
        log.warn('bridge', `PROJECT_SAVED failed: ${msg.payload.error ?? 'unknown'}`)
        notifications.pushError(`Save failed: ${msg.payload.error ?? 'unknown error'}`)
      }
      break
    }

    case 'PROJECT_LOAD_FAILED': {
      log.warn('bridge', `PROJECT_LOAD_FAILED ${msg.payload.filePath}: ${msg.payload.error}`)
      useNotificationsStore().pushError(
        `Could not open project: ${msg.payload.error || msg.payload.filePath}`
      )
      // Clear the persisted last-path so a failed file doesn't keep
      // re-failing at every launch. The user can pick it again
      // explicitly with File > Open.
      window.silverdaw.setLastProjectPath(null)
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

    case 'LIBRARY_ITEM_BPM': {
      useLibraryStore().setItemBpm(msg.payload.itemId, msg.payload.bpm)
      log.info('bridge', `LIBRARY_ITEM_BPM itemId=${msg.payload.itemId} bpm=${msg.payload.bpm.toFixed(2)}`)
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

    default:
      assertNever(msg)
  }
}

/**
 * Cache-file binary layout (mirrors `backend/src/PeaksCache.cpp::CacheHeader`):
 *
 *   bytes  0..3   u32 LE magic       — 0x53445057 ('SDPW')
 *   bytes  4..7   u32 LE version     — 1
 *   bytes  8..11  u32 LE peaksPerSec
 *   bytes 12..15  u32 LE peakCount   — (min, max) pair count
 *   bytes 16..23  f64 LE sampleRate
 *   bytes 24..    peakCount * 2 * f32 LE peak values, alternating min, max
 */
const PEAKS_FILE_MAGIC = 0x53445057
const PEAKS_FILE_HEADER_SIZE = 24

async function loadPeaksFromCache(payload: WaveformReadyPayload): Promise<void> {
  const { clipId, cachePath, peakCount, sampleRate } = payload
  let buffer: ArrayBuffer | null
  try {
    buffer = await window.silverdaw.readPeaksCacheFile(cachePath)
  } catch (err) {
    log.warn('bridge', `WAVEFORM_READY read failed clipId=${clipId}: ${String(err)}`)
    return
  }
  if (!buffer) {
    log.warn('bridge', `WAVEFORM_READY no data clipId=${clipId} cachePath=${cachePath}`)
    return
  }
  if (buffer.byteLength < PEAKS_FILE_HEADER_SIZE) {
    log.warn('bridge', `WAVEFORM_READY short file clipId=${clipId} bytes=${buffer.byteLength}`)
    return
  }
  const view = new DataView(buffer)
  const magic = view.getUint32(0, /* littleEndian */ true)
  if (magic !== PEAKS_FILE_MAGIC) {
    log.warn('bridge', `WAVEFORM_READY bad magic clipId=${clipId} magic=0x${magic.toString(16)}`)
    return
  }
  const floatCount = peakCount * 2
  const expectedBytes = PEAKS_FILE_HEADER_SIZE + floatCount * Float32Array.BYTES_PER_ELEMENT
  if (buffer.byteLength < expectedBytes) {
    log.warn(
      'bridge',
      `WAVEFORM_READY size mismatch clipId=${clipId} got=${buffer.byteLength} expected>=${expectedBytes}`
    )
    return
  }
  // Slice + copy into a fresh Float32Array so it isn't backed by the
  // raw IPC buffer (which the Pinia store would otherwise hold for the
  // lifetime of the clip — multi-MB live retention for every project).
  const view32 = new Float32Array(buffer, PEAKS_FILE_HEADER_SIZE, floatCount)
  const peaks = new Float32Array(view32)
  useProjectStore().setClipPeaks(clipId, peaks, sampleRate)
  log.info('bridge', `WAVEFORM_READY clipId=${clipId} peaks=${peakCount}`)
}

function assertNever(value: never): never {
  throw new Error(`[bridge] unhandled inbound message: ${JSON.stringify(value)}`)
}

/**
 * Validate a raw parsed envelope against the inbound catalogue. Returns the
 * narrowed message on success, `null` on any structural mismatch (and logs
 * a warning so unexpected wire traffic is visible during development).
 */
function validateInbound(raw: unknown): BridgeInboundMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    console.warn('[bridge] dropped non-object envelope', raw)
    return null
  }
  const env = raw as RawBridgeEnvelope
  if (!isBridgeInboundType(env.type)) {
    console.warn('[bridge] dropped unknown envelope type', env.type)
    return null
  }
  return narrowPayload(env.type, env.payload)
}

/** Per-arm payload guard. Keeps the type narrowing tied to the discriminant. */
function narrowPayload(type: BridgeInboundType, payload: unknown): BridgeInboundMessage | null {
  switch (type) {
    case 'READY':
      return isReadyPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_STATE':
      return isProjectStatePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PLAYHEAD_UPDATE':
      return isPlayheadUpdatePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CLIP_ADDED':
    case 'CLIP_ADD_FAILED':
      return isClipAckPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_ADDED':
      return isTrackAddedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_REMOVED':
      return isTrackRemovedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CLIP_REMOVED':
      return isClipRemovedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'TRACK_GAIN_APPLIED':
      return isTrackGainAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_SAVED':
      return isProjectSavedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_LOAD_FAILED':
      return isProjectLoadFailedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_RENAMED':
      return isProjectRenamedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_DIRTY':
      return isProjectDirtyPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'WAVEFORM_READY':
      return isWaveformReadyPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'LIBRARY_ITEM_BPM':
      return isLibraryItemBpmPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'PROJECT_BPM_APPLIED':
      return isProjectBpmAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    default:
      return assertNeverType(type)
  }
}

function payloadMismatch(type: BridgeInboundType, payload: unknown): null {
  console.warn('[bridge] dropped envelope with malformed payload', type, payload)
  return null
}

function assertNeverType(value: never): never {
  throw new Error(`[bridge] unhandled inbound envelope type: ${String(value)}`)
}
