// Bridge protocol facade: the single source of truth for `{ type, payload }` WebSocket envelopes.
// Main owns the dynamic loopback port, spawns the backend with `--port`, and exposes it via IPC.
// First client envelope must be `AUTH` with the per-session token from trusted IPC/env.

export * from './bridge/outbound'
export * from './bridge/inbound'
