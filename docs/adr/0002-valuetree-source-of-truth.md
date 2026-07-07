# ADR 0002 — Backend `ValueTree` is the single source of truth for project state

- **Date:** 2026-05-14 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

All project state — tracks, clips, library, markers, view state, identity —
lives in a `juce::ValueTree` in the backend, with a `juce::UndoManager` for
undo/redo. After AUTH the backend sends one full `PROJECT_STATE` snapshot; the
renderer's Pinia stores **mirror** it and own only **ephemeral interaction
state** (hover, in-flight drag, transient highlight). Persisted view state (zoom,
scroll, selected track, open FX panel) is backend-authoritative and round-trips
via `PROJECT_SET_VIEW`. A `reset=true` snapshot wipes optimistic local state; the
connect path merges additively.

## Why

- One authoritative model avoids two divergent state trees drifting apart.
- `ValueTree` gives change broadcasting, serialisation, and undo essentially for
  free, and is the natural JUCE persistence primitive (drives `.silverdaw`
  save/load via a ValueTree↔JSON converter).
- Recovery is well-defined: a respawned engine is empty until the project is
  reloaded and re-emits its snapshot (ADR 0008).

## Rejected alternatives

- **Renderer-owned state, backend stateless.** The audio engine needs the model
  locally anyway; duplicating authority invites drift and race conditions.
- **Shared/duplicated undo stacks.** Two undo histories cannot stay coherent.
