// Bridge wire-protocol catalogue.
//
// Single source of truth for every JSON envelope crossing the WebSocket bridge
// between the renderer and the JUCE backend. Both directions are catalogued
// as discriminated unions so the renderer can exhaustively dispatch inbound
// messages and the type checker can prove every `send()` carries the right
// payload shape.
//
// Wire format (matches `backend/src/BridgeServer.cpp::broadcast` and
// `backend/src/BridgeServer.cpp::onIncoming`):
//
//     { "type": "<UPPER_SNAKE_CASE>", "payload": { ... } | undefined }
//
// ─── Port contract ──────────────────────────────────────────────────────────
// The bridge listens on `ws://127.0.0.1:<port>`. There is exactly one source
// of truth for `<port>`:
//
//   1. Electron **main** probes for a free loopback port at startup
//      (`findFreeBridgePort` in `frontend/src/main/index.ts`).
//   2. Main spawns the JUCE backend with `--port <N>`. The backend has no
//      default and refuses to start without `--port` — a missing `--port`
//      is always a configuration bug (see
//      `backend/src/Main.cpp::resolveBridgePort`).
//   3. Main exposes the same value to the renderer via the `bridge:getPort`
//      IPC. The renderer fetches it in `lib/bridgeService.ts::resolveBridgeConnection`
//      and dials `ws://127.0.0.1:<that>` from there.
//
// If you change the port-resolution rule on either end, update both sides
// AND this comment so the three processes stay in lockstep.
//
// ─── AUTH contract ──────────────────────────────────────────────────────────
// The first envelope a client sends MUST be `AUTH` with the per-session
// token from main (via `bridge:getToken` IPC + `SILVERDAW_BRIDGE_TOKEN`
// env var to the backend). Pre-AUTH socket activity is closed without
// reply. See `backend/src/BridgeServer.cpp::onIncomingFromClient`.
//
// This module is the stable public facade for the bridge protocol. The
// catalogue is split by wire direction into `./bridge/outbound` (pure payload
// interfaces + the outbound map/union) and `./bridge/inbound` (zod schemas,
// inferred types, the inbound map/union, and the runtime type guards).
// Import from `@shared/bridge-protocol` as before; the split is transparent.

export * from './bridge/outbound'
export * from './bridge/inbound'
