# ADR 0024 — One original BPM per clip, resolved identically in both processes

- **Date:** 2026-08-04 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

A clip or library item has **exactly one original (source) BPM** and **one warp
target** — a pinned tempo ratio, or nothing, meaning "follow the project BPM".
Neither process may derive its own version of either.

- The renderer resolves the original BPM only through
  `libraryItemSourceBpm` in `frontend/src/renderer/src/stores/libraryItemHelpers.ts`.
- The engine resolves it only through `ProjectState::getLibraryItemBpm` in
  `backend/src/project/ProjectStateClips.cpp`.
- The two implement the same rules, in this order:
  1. A one-shot (`audioType: "simple"`, inherited through `derivedFrom`) has
     **no** tempo at all — not even an inherited one.
  2. Otherwise the item's own BPM, if it has one.
  3. Otherwise the BPM of the item it was derived from.
- Whether the project tempo has been established is likewise one fact,
  `bpmSeeded`, owned by `ProjectState` and mirrored to the renderer on the
  project snapshot and on `PROJECT_BPM_APPLIED`. The renderer must not infer it.

Nothing else may read `item.bpm` directly to decide how a clip is drawn,
gridded, warped or stretched.

## Context

Source BPM had drifted into four separate implementations: the drop paths read
`item.bpm` raw, `libraryItemSourceBpm` and `libraryItemWarpSourceBpm` each
applied their own inheritance rules, and the backend had `getLibraryItemBpm`.
They disagreed on exactly the cases that matter — a saved sample, a stem, a
clip cut from a stem, a one-shot with a musical parent.

Because the renderer draws a clip from its own answer and the engine plays it
from the backend's, a disagreement is directly audible: the clip is drawn
stretched to the project tempo while the engine plays it dry, or a one-shot is
gridded and warped to a tempo it never had. The same class of bug produced a
music sample that refused to auto-warp on drop while showing warp controls that
offered only a free stretch percentage.

The renderer had also invented its own answer to "is the project tempo
established?" — it asked whether the timeline held any other clip. That is a
different question: a project can have a seeded tempo and an empty timeline, in
which case the first clip dropped was silently left unwarped.

## Alternatives rejected

- **Keep per-surface resolvers and add tests pinning them together.** Tests
  would document the drift rather than remove it, and every new surface would
  have to rediscover the rules.
- **Send the resolved BPM with every command so the renderer decides.** The
  engine still needs the value for mixdown, sample export and project load,
  where no renderer command is in flight; it would need a resolver anyway.
- **Store a denormalised `sourceBpm` on each clip.** A second copy of a fact
  that already exists on the library item, and one that goes stale when the item
  is reanalysed or its tempo corrected by hand (ADR 0002).

## Consequences

- Correcting a source's tempo now moves every derived stem, saved clip and
  sample that inherits from it, on both sides, together.
- `libraryItemWarpSourceBpm` survives only as a deprecated pass-through, kept as
  a named entry point for the warp UI; it no longer applies a rule of its own.
- Projects saved before this keep opening (ADR 0019). Samples persisted with the
  wrong `kind` are repaired on load by
  `ProjectState::repairLegacyLibraryItemKinds`, so an old project fixes itself
  forward on its next save, and every new bridge field is optional so an older
  payload still parses.
- `PROJECT_BPM_APPLIED` now broadcasts whenever the tempo is seeded, including
  when the seeded value has not moved, because the renderer needs the flag.
