# ADR 0005 — Dynamic loopback port + per-session AUTH token

- **Date:** 2026-05-14 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

Electron main probes a free loopback port in `[8765, 8784]` at startup, spawns
the backend with `--port <N>`, and exposes the port plus a per-session random
AUTH token to the renderer over IPC. The backend has **no default port** and
refuses to start without `--port` (exit code 2). It binds `127.0.0.1` only. The
first envelope on every socket must be `AUTH { token }`; a wrong or missing token
closes the connection. A supervised respawn reuses the **same** port and token so
the renderer reconnects transparently (ADR 0008).

## Why

- A fixed port lets a leftover Silverdaw process lock new instances out; probing
  a free port avoids that.
- Loopback binding + a per-session token keeps other local processes off the
  bridge — the engine exposes powerful file and audio commands.

## Rejected alternatives

- **Fixed well-known port.** Collides with stale processes and other apps.
- **No AUTH (loopback deemed safe).** Any local process could drive the engine;
  cheap token gating is worth it.
