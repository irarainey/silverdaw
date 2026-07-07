# ADR 0003 — Text-only bridge; bulk data via disk

- **Date:** 2026-05-14 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

The WebSocket bridge is **text-only**: every frame is a JSON `{ type, payload }`
envelope carrying the control plane (commands, state, metadata, progress). There
is no binary frame plane. Bulk data — audio files, waveform peaks, stems,
mixdowns, project files — is written to a stable disk location by the backend,
which then sends a small `*_READY` envelope pointing at the path; the renderer
reads the file via Electron main IPC.

## Why

- IXWebSocket runs a single-threaded I/O loop. Streaming multi-megabyte peak or
  audio payloads over it starves the lightweight control traffic and stalls
  transport responsiveness.
- Audio, stems, and mixdowns already have to live on disk; routing peaks the same
  way keeps one consistent bulk-data model.

## Rejected alternatives

- **Binary WebSocket frames for peaks/audio.** Reintroduces I/O-loop starvation
  and a second serialisation path to maintain.
- **A second socket for bulk data.** More moving parts than a disk cache + path
  pointer, with no real gain.
