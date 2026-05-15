// WebSocket bridge to the JUCE backend.
//
// - Connects to `ws://127.0.0.1:<port>` on `connect()`, where `<port>` is
//   resolved from main via `window.jackdaw.getBridgePort()` so the renderer
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
import {
  isBridgeInboundType,
  isClipAckPayload,
  isPlayheadUpdatePayload,
  isReadyPayload,
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
 * Cached promise for the resolved bridge URL. Resolving the port goes
 * through an async preload IPC; we only need to do it once per session,
 * and concurrent `connect()` calls share the same in-flight promise.
 */
let bridgeUrlPromise: Promise<string> | null = null

function resolveBridgeUrl(): Promise<string> {
  if (bridgeUrlPromise) return bridgeUrlPromise
  const api = window.jackdaw
  const portPromise: Promise<number> =
    api && typeof api.getBridgePort === 'function'
      ? api.getBridgePort().catch((err) => {
          console.warn('[bridge] getBridgePort failed; falling back to default', err)
          return DEFAULT_BRIDGE_PORT
        })
      : Promise.resolve(DEFAULT_BRIDGE_PORT)
  bridgeUrlPromise = portPromise.then((port) => `ws://${BRIDGE_HOST}:${port}`)
  return bridgeUrlPromise
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

  void resolveBridgeUrl().then((url) => {
    // Bail if `disconnect()` ran between the resolve and the open.
    if (stopped) return
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    openSocket(url)
  })
}

function openSocket(url: string): void {
  const ws = new WebSocket(url)
  socket = ws

  ws.addEventListener('open', () => {
    reconnectDelay = RECONNECT_DELAY_MS
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
    case 'CLIP_ADD_FAILED':
      // Acknowledgements; not used yet but useful when bugs surface.
      console.log('[bridge]', msg.type, msg.payload)
      break

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
