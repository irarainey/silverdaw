// WebSocket bridge to the JUCE backend.
//
// - Connects to ws://localhost:8765 on `connect()`.
// - Reconnects with backoff if the socket drops (backend restarts during dev).
// - Dispatches incoming `{ type, payload }` envelopes to the appropriate
//   Pinia store; provides a typed `send()` for outgoing commands.

import { useTransportStore } from '@/stores/transportStore'

const BRIDGE_URL = 'ws://localhost:8765'
const RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 5000

export interface BridgeMessage {
  type: string
  payload?: unknown
}

interface PlayheadUpdatePayload {
  positionMs: number
  isPlaying: boolean
}

let socket: WebSocket | null = null
let reconnectDelay = RECONNECT_DELAY_MS
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false

/** Open the connection. Safe to call multiple times. */
export function connect(): void {
  stopped = false
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }

  const ws = new WebSocket(BRIDGE_URL)
  socket = ws

  ws.addEventListener('open', () => {
    reconnectDelay = RECONNECT_DELAY_MS
    useTransportStore().setConnected(true)
    console.log('[bridge] connected')
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
    try {
      const msg = JSON.parse(e.data) as BridgeMessage
      dispatch(msg)
    } catch (err) {
      console.warn('[bridge] failed to parse message', err, e.data)
    }
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
export function send(type: string, payload?: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn('[bridge] not connected; dropping', type)
    return
  }
  const env: BridgeMessage = payload === undefined ? { type } : { type, payload }
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

function dispatch(msg: BridgeMessage): void {
  switch (msg.type) {
    case 'READY':
      // Backend says hello; nothing to do yet.
      break

    case 'PLAYHEAD_UPDATE': {
      const p = msg.payload as PlayheadUpdatePayload | undefined
      if (!p) return
      const t = useTransportStore()
      t.setPlaybackState(p.isPlaying, p.positionMs)
      break
    }

    case 'CLIP_ADDED':
    case 'CLIP_ADD_FAILED':
      // Acknowledgements; not used yet but useful when bugs surface.
      console.log('[bridge]', msg.type, msg.payload)
      break

    default:
      console.log('[bridge] unhandled:', msg.type, msg.payload)
  }
}
