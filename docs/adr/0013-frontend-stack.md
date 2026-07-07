# ADR 0013 — Frontend stack: Vue 3 + Pinia + PixiJS + Tailwind

- **Date:** 2026-05-13 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

The renderer is **Vue 3** (Composition API, `<script setup lang="ts">`) +
**Pinia** stores + **PixiJS 8** for the timeline + **Tailwind v4** for styling,
built with **electron-vite**.

## Why

- Vue's Composition API suits reactive audio/transport state and is fast to
  build in; Pinia is the official, TypeScript-first store.
- **PixiJS (WebGL)** is what makes the timeline viable — many clips plus a 60 fps
  playhead without the jank a DOM/SVG canvas would hit.
- Tailwind builds the consistent dark UI (ADR 0012) quickly; electron-vite gives
  Electron + Vite + HMR preconfigured.

## Rejected alternatives

- **DOM/SVG timeline.** Cannot sustain 60 fps with many clips; PixiJS exists
  precisely to avoid this.
- **A heavier canvas/charting library.** PixiJS covers the need with no extra
  waveform dependency (peaks are drawn directly from backend data).
