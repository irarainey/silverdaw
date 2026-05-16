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

import { useTransportStore } from '@/stores/transportStore'
import { useProjectStore } from '@/stores/projectStore'
import {
  isBridgeInboundType,
  isClipAckPayload,
  isPlayheadUpdatePayload,
  isReadyPayload,
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
    // Per-session AUTH MUST be the first envelope on every new socket:
    // the backend closes any client whose first message isn't a valid AUTH.
    // We push it directly (instead of via the typed `send()`) so it bypasses
    // the connected-state guard — at this instant `socket.readyState` is
    // OPEN but `setConnected(true)` hasn't been called yet.
    try {
      ws.send(JSON.stringify({ type: 'AUTH', payload: { token } }))
    } catch (err) {
      console.warn('[bridge] failed to send AUTH envelope', err)
    }
    useTransportStore().setConnected(true)
    console.log('[bridge] connected', url)
  })

  ws.addEventListener('close', () => {
    useTransportStore().setConnected(false)
    socket = null
    if (!stopped) scheduleReconnect()
  })

  ws.addEventListener('error', (e) => {
    console.warn('[bridge] socket error', e)
  })

  ws.addEventListener('message', (e) => {
    let raw: unknown
    try {
      raw = JSON.parse(e.data)
    } catch (err) {
      console.warn('[bridge] failed to parse message', err, e.data)
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
    return
  }
  const env = payload === undefined ? { type } : { type, payload }
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
  switch (msg.type) {
    case 'READY':
      // Backend says hello; nothing to do yet.
      break

    case 'PLAYHEAD_UPDATE': {
      const t = useTransportStore()
      t.setPlaybackState(msg.payload.isPlaying, msg.payload.positionMs)
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
        msg.payload.filePath,
        msg.payload.ok,
        msg.payload.error
      )
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
    case 'PLAYHEAD_UPDATE':
      return isPlayheadUpdatePayload(payload) ? { type, payload } : payloadMismatch(type, payload)
    case 'CLIP_ADDED':
    case 'CLIP_ADD_FAILED':
      return isClipAckPayload(payload) ? { type, payload } : payloadMismatch(type, payload)
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
