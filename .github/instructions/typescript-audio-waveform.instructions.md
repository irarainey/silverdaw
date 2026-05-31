---
description: "TypeScript standards for Silverdaw waveform, timeline, and audio-processing UI"
applyTo: "frontend/src/**/*.ts"
---

## TypeScript Audio and Waveform Instructions

Use these rules when modifying Silverdaw's TypeScript audio-facing code:
waveform decoding and peaks, import/reanalysis, timeline rendering, warp math,
music-time conversion, preview state, and bridge protocol handling. Accuracy
and performance are critical because these paths define what the user hears
and what the timeline visually promises.

## Core Principles

- Keep audio math explicit and testable. Prefer small pure helpers for tempo,
  beat, warp, sample, and timeline conversions.
- Treat visual waveform and beat-marker placement as correctness-sensitive,
  not decorative. The UI must match backend playback semantics.
- Avoid approximations unless they are deliberate, documented, and covered by
  tests.
- Preserve project responsiveness. Large audio files, waveform peaks, and
  PixiJS scene rebuilds can become expensive quickly.
- Reuse existing stores, composables, and shared bridge contracts before
  adding new state or message shapes.

## Time and Unit Correctness

- Name variables by domain and unit: `sourceMs`, `timelineMs`, `durationMs`,
  `sampleRate`, `sourceBpm`, `projectBpm`, `pxPerSecond`, `beatSec`.
- Never mix source-time trim fields with timeline/effective duration.
  Warped clips store source-time `inMs` and `durationMs`, but render and
  collide on the timeline as `durationMs / tempoRatio`.
- Keep ratio direction consistent:
  - `tempoRatio = projectBpm / sourceBpm`;
  - source offset from timeline offset is `timelineOffset * tempoRatio`;
  - timeline offset from source offset is `sourceOffset / tempoRatio`.
- Use full-precision BPM for math. Round only at display time.
- Use one shared helper for a timing rule whenever possible, especially for
  warp duration, beat spacing, and project-grid conversions.

## Waveform and Peaks

- Keep peak arrays as typed arrays (`Float32Array`) or plain numeric arrays
  only when required by persistence or bridge payloads.
- Avoid copying large peak arrays in reactive state. Reuse references where
  safe, and bump explicit revision counters when a redraw is needed.
- Decimate waveform rendering by pixel range, not by source array index alone.
  At low zoom, aggregate min/max over all peaks represented by a pixel.
  At high zoom, stretch the available peak window across the visible width.
- Always clamp peak-window indices to valid ranges.
- Do not block the renderer with avoidable full-file processing on hot UI
  paths. Decode/import work should stay in existing async flows.

## Timeline and PixiJS Rendering

- Redraw full PixiJS scene graphs only when content, zoom, BPM, viewport, or
  analysis data changes. Use layer translation for scroll.
- Keep per-frame work limited to cached graphics updates such as the playhead
  or intentionally throttled status animations.
- Keep hit regions in the same coordinate and duration model as drawn clips.
- When adding visible clip state, update drawing, hit testing, overlays, and
  watchers together.
- Avoid deep reactive watches over large clip or peak structures. Prefer
  stable derived keys, revision counters, or targeted events.

## Beat Markers and Grid Accuracy

- Use a uniform `bpm + beatAnchorSec` grid for visible beat markers unless a
  feature explicitly needs raw detected beat timestamps.
- Treat raw detected beats as potentially jittery and unsuitable for uniform
  marker spacing without filtering.
- When a clip is warped, project source beat offsets to timeline positions
  using the effective tempo ratio.
- Keep beat snapping, drop previews, timeline markers, and Clip Editor marker
  logic aligned so the same clip does not appear to land differently in
  different surfaces.

## Warp and Preview State

- A clip's renderer warp state must mirror backend engine state. Backend-
  originated updates should apply locally without echoing a bridge command
  back.
- Saved clips should preserve the user's intended musical result. Store warp
  settings non-destructively unless the feature explicitly bakes audio.
- Show pending states when warp is waiting on analysis or backend application.
  Do not make users infer that work is happening from delayed UI changes.
- Keep preview playback options aligned with timeline playback for saved clips
  and warped clips.

## Bridge and Store Patterns

- Centralize wire payload shapes in `frontend/src/shared/bridge-protocol.ts`.
  Add or update runtime guards and tests when payloads change.
- Stores should own domain state; composables should own view interaction and
  rendering mechanics.
- Keep local-only state application paths for backend-originated messages that
  must not echo back over the bridge.
- Surface user-visible failures through the existing notification/logging
  patterns, not silent returns.

## Performance Rules

- Avoid `Array.from`, spreads, `map`, or `filter` over large peak arrays in
  render loops.
- Avoid repeatedly searching large stores inside inner pixel loops. Resolve
  clip/library metadata before entering hot loops.
- Throttle expensive visual updates. Do not create independent animation
  loops when the timeline's existing RAF or redraw lifecycle can be reused.
- Use `Math.floor`, `Math.ceil`, and clamping deliberately at boundaries.
  Off-by-one timing errors can show as beat drift or waveform misalignment.
- Keep memory lifetime explicit for object URLs, high-resolution peaks, and
  temporary decoded audio data.

## Tests and Validation

- Add Vitest coverage for pure timing, warp, music-time, and protocol logic.
- Include edge cases: missing BPM, zero/invalid BPM, pinned ratios, follow-
  project ratios, variable tempo flags, trimmed clips, and saved clips.
- Validate UI-affecting math by checking the exact output shape where
  possible, not only that functions return truthy values.
- Run the existing frontend checks after changes (this repo uses **pnpm** —
  never `npm`):
  - `pnpm run typecheck`
  - `pnpm run test -- --run`
  - `pnpm run lint`

## Comments and Documentation

- Comment non-obvious unit conversions, timing-domain changes, and performance
  constraints.
- Do not comment obvious assignments or UI wiring.
- Update documentation when behavior changes the import, preview, warp, or
  timeline workflow.
