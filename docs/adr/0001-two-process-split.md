# ADR 0001 — Two-process split: Electron UI + headless JUCE engine

- **Date:** 2026-05-13 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

Silverdaw is two processes: an Electron 42 + Vue 3 UI and a headless JUCE 8 C++
audio engine (`SilverdawBackend.exe`). Electron main spawns and supervises the
engine; they communicate over a loopback bridge (ADR 0003).

## Why

- Fault isolation — a driver or audio-callback fault takes down the engine
  process, not the UI, which makes crash recovery a feature (ADR 0008) rather
  than a lost session.
- Each side uses its natural stack: real-time C++/JUCE for audio, web tech for a
  rich, fast-to-build UI.
- Keeps JUCE UI subsystems entirely unused; all rendering is Electron + PixiJS.

## Rejected alternatives

- **Single JUCE app with a native UI.** Slower UI iteration, no process
  isolation, and a heavier path to the beginner-friendly UX goal.
- **Electron with a WASM/JS audio engine.** Cannot meet the real-time DSP
  needs.
