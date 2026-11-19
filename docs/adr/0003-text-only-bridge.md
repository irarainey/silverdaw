# ADR 0003 — Text-only bridge; bulk data via disk

- **Date:** 2026-05-14 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

The WebSocket bridge is **text-only**: every frame is a JSON `{ type, payload }`
envelope carrying the control plane (commands, state, metadata, progress). There
is no binary frame plane. Audio files, waveform peaks, stems, exports, and
project files stay on disk. A small envelope identifies the result: for
example, `WAVEFORM_READY` points to peaks the renderer reads via main IPC,
whereas `MIXDOWN_DONE` and `TRACK_EXPORT_READY` report a file and a folder
respectively without the renderer having to read any audio back.

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
