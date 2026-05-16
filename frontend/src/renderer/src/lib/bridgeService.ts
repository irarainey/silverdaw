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
// Two physical frame types:
//
//   - Text frames carry JSON envelopes (control plane: commands, acks,
//     PROJECT_STATE, PLAYHEAD_UPDATE, …).
//   - Binary frames carry length-prefixed JSON header + raw bytes payload
//     (data plane: WAVEFORM_DATA today; stems / previews later). Layout:
//
//         | u32 LE: jsonLen | jsonLen UTF-8 bytes | raw bytes |
//
//     Demuxed in `dispatchBinaryFrame` below.

import { useTransportStore } from '@/stores/transportStore'
import { useProjectStore } from '@/stores/projectStore'
import { log } from '@/lib/log'
import {
  isBridgeInboundType,
  isClipAckPayload,
  isPlayheadUpdatePayload,
  isProjectStatePayload,
  isReadyPayload,
  isTrackAddedPayload,
  isTrackGainAppliedPayload,
  isTrackRemovedPayload,
  type BridgeInboundMessage,
  type BridgeInboundType,
  type BridgeOutboundArgs,
  type BridgeOutboundType
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
  // Binary frames (WAVEFORM_DATA and friends) deliver as ArrayBuffer so
  // the demuxer can slice them without a Blob -> arrayBuffer round trip.
  ws.binaryType = 'arraybuffer'
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
    if (e.data instanceof ArrayBuffer) {
      dispatchBinaryFrame(e.data)
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
      useTransportStore().setPlaybackState(false, 0)
      send('TRANSPORT_STOP')
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
      useTransportStore().setPosition(msg.payload.positionMs)
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

    default:
      assertNever(msg)
  }
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
    case 'TRACK_GAIN_APPLIED':
      return isTrackGainAppliedPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
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

/**
 * In-flight chunked WAVEFORM_DATA frames keyed by clipId. Each entry
 * pre-allocates an Int16Array sized to the announced total peak count
 * and tracks which chunks have arrived. When the final chunk lands we
 * dequantise to Float32 and call `setClipPeaks` once.
 *
 * Map entries are dropped after assembly; if a later WAVEFORM_DATA for
 * the same clipId arrives (e.g. the user re-imports the same file), a
 * fresh entry is created.
 */
interface PendingWaveform {
  peakCount: number
  sampleRate: number
  chunkCount: number
  receivedMask: boolean[]
  receivedChunks: number
  buffer: Int16Array
}
const pendingWaveforms = new Map<string, PendingWaveform>()

/**
 * Binary frame layout (see file header):
 *
 *   | u32 LE: headerLen | headerLen UTF-8 bytes (JSON) | int16 LE payload slice |
 *
 * Today the only inbound binary envelope is `WAVEFORM_DATA`, which is
 * chunked so a single clip's peaks arrive across N small frames. See
 * `backend/src/Waveform.cpp::encodeWaveformFrames` for the producer
 * side; the multi-frame protocol is what prevents IXWebSocket's I/O
 * loop from stalling on a single oversized binary send.
 */
function dispatchBinaryFrame(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 4) {
    console.warn('[bridge] binary frame too short to contain header length', buffer.byteLength)
    return
  }
  const view = new DataView(buffer)
  const headerLen = view.getUint32(0, true /* little-endian */)
  if (headerLen === 0 || headerLen > buffer.byteLength - 4) {
    console.warn('[bridge] binary frame header length out of range', headerLen, buffer.byteLength)
    return
  }
  const headerBytes = new Uint8Array(buffer, 4, headerLen)
  let header: unknown
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes))
  } catch (err) {
    console.warn('[bridge] binary frame header is not valid JSON', err)
    return
  }
  if (typeof header !== 'object' || header === null) {
    console.warn('[bridge] binary frame header is not an object', header)
    return
  }
  const h = header as Record<string, unknown>
  if (h.type !== 'WAVEFORM_DATA') {
    console.warn('[bridge] unknown binary frame type', h.type)
    return
  }
  if (
    typeof h.clipId !== 'string' ||
    typeof h.peakCount !== 'number' ||
    typeof h.chunkIndex !== 'number' ||
    typeof h.chunkCount !== 'number' ||
    typeof h.chunkOffset !== 'number'
  ) {
    console.warn('[bridge] WAVEFORM_DATA header missing required fields', h)
    return
  }
  const payloadOffset = 4 + headerLen
  const payloadBytes = buffer.byteLength - payloadOffset
  if (payloadBytes % 2 !== 0) {
    console.warn('[bridge] WAVEFORM_DATA payload not a multiple of 2 bytes', payloadBytes)
    return
  }
  const chunk = new Int16Array(buffer.slice(payloadOffset))

  const clipId = h.clipId
  const totalInts = h.peakCount * 2

  let pending = pendingWaveforms.get(clipId)
  // Reset the accumulator if the announced size has changed (e.g. file
  // re-imported with different length); use the latest header's
  // metadata.
  if (!pending || pending.peakCount !== h.peakCount || pending.chunkCount !== h.chunkCount) {
    pending = {
      peakCount: h.peakCount,
      sampleRate: typeof h.sampleRate === 'number' ? h.sampleRate : 0,
      chunkCount: h.chunkCount,
      receivedMask: new Array(h.chunkCount).fill(false) as boolean[],
      receivedChunks: 0,
      buffer: new Int16Array(totalInts)
    }
    pendingWaveforms.set(clipId, pending)
  }

  if (h.chunkOffset + chunk.length > totalInts) {
    console.warn('[bridge] WAVEFORM_DATA chunk overruns buffer', h)
    return
  }
  pending.buffer.set(chunk, h.chunkOffset)
  if (!pending.receivedMask[h.chunkIndex]) {
    pending.receivedMask[h.chunkIndex] = true
    pending.receivedChunks++
  }
  log.debug(
    'bridge',
    `recv WAVEFORM_DATA clipId=${clipId} chunk=${h.chunkIndex + 1}/${h.chunkCount} bytes=${buffer.byteLength}`
  )

  if (pending.receivedChunks < pending.chunkCount) return

  // All chunks in — dequantise int16 [-32767, 32767] → float32 [-1, 1]
  // and hand to the project store. The backend clamped before quantising
  // so we don't need to clamp here.
  const peaks = new Float32Array(totalInts)
  const inv = 1 / 32767
  for (let i = 0; i < totalInts; i++) peaks[i] = pending.buffer[i]! * inv
  pendingWaveforms.delete(clipId)
  log.info('bridge', `assembled WAVEFORM_DATA clipId=${clipId} peaks=${peaks.length / 2}`)
  useProjectStore().setClipPeaks(clipId, peaks, pending.sampleRate)
}
