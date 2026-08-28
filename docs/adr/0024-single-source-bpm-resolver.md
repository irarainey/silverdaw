# ADR 0024 — One original BPM per clip, resolved identically in both processes

- **Date:** 2026-08-03 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

A clip or library item has **exactly one original (source) BPM** and **one warp
target** — a pinned tempo ratio, or nothing, meaning "follow the project BPM".
Neither process may derive its own version of either.

- The renderer resolves the original BPM only through
  `libraryItemSourceBpm` in `frontend/src/renderer/src/stores/libraryItemHelpers.ts`.
- The engine resolves it only through `ProjectState::getLibraryItemBpm` in
  `backend/src/project/ProjectStateClips.cpp`.
- A derived item **acquires** its tempo the same way: automatic detection
  (`ensureBpmDetection`) inherits from the source instead of analysing the item's
  own audio, because a saved sample or clip is usually far too short to detect a
  trustworthy tempo from. A user-invoked **Reanalyse** is an explicit instruction
  and keeps whatever it detects.
- The two implement the same rules, in this order:
  1. A one-shot (`audioType: "simple"`, inherited through `derivedFrom`) has
     **no** tempo at all — not even an inherited one.
  2. Otherwise its **recorded musical length**, if it has one: `musicalBeats`
     records how many whole beats of music the file contains, measured against
     the grid of the item it was cut from, and yields
     `musicalBeats * 60000 / durationMs`. This is a measurement of the audio
     rather than an opinion about it, so it outranks any detected tempo. A
     hand-set tempo clears it; a Reanalyse deliberately does not.
  3. Otherwise the item's own BPM, if it has one.
  4. Otherwise the BPM of the item it was derived from.
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

Inheritance alone was not enough. A clip cut to two bars can still be
reanalysed by the user, and detection on four seconds of audio sees only about
eight beats: it returned 100.768 BPM for an excerpt that is exactly two bars at
105.804. The clip was then drawn and warped a few percent short at both ends.
Two facts were being conflated — how fast the audio is thought to be, and how
much music it contains. Recording the second (`musicalBeats`) keeps a clip cut
to a number of bars at that number of bars whatever the first later says, while
leaving Reanalyse free to detect and keep what it finds. It is recorded only
when the cut really is a whole number of beats, within a tolerance that keeps
the implied stretch under ~1%; anything else records nothing rather than being
rounded onto the grid, which would bend the tempo of an excerpt that is
legitimately not a whole number of bars.

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
- **Snap a cut to the nearest whole bar when its tempo is re-detected.** It
  would silently bend the tempo of any excerpt that legitimately is not a whole
  number of bars, and it guesses at save time what only the source's grid
  actually knows.
- **Let Reanalyse clear `musicalBeats`.** Simpler, but it defeats the point: a
  clip cut to two bars would stop being two bars the moment its tempo was
  re-detected, which is the defect this exists to fix.

## Consequences

- Correcting a source's tempo now moves every derived stem, saved clip and
  sample that inherits from it, on both sides, together.
- `libraryItemWarpSourceBpm` survives only as a deprecated pass-through, kept as
  a named entry point for the warp UI; it no longer applies a rule of its own.
- Projects saved before this keep opening (ADR 0019). Library items persisted
  with the wrong `kind` — a sample stored as a plain import, or a stem demoted
  by a reanalysis — are repaired by `ProjectState::repairLibraryItemKinds`,
  applied both when a project is opened and when one is read as an import
  source, so an old project fixes itself forward without needing to be opened
  first. Every new bridge field is optional, so an older payload still parses,
  and an item with no `musicalBeats` simply falls through to rule 3.
- `PROJECT_BPM_APPLIED` now broadcasts whenever the tempo is seeded, including
  when the seeded value has not moved, because the renderer needs the flag.
- Changing the project tempo now rescales every clip's start by
  `previousBpm / newBpm` so the arrangement keeps its musical shape, and warps
  any unwarped clip that has a source tempo when the Auto-warp clips to project
  tempo preference is on. The preference lives in the renderer, so `PROJECT_SET_BPM`
  carries it as an optional `autoWarp` flag; both are one undoable step.
- Whether a tempo mismatch counts as a warp at all is judged on the drift it
  produces across the clip, not on a flat ratio epsilon, and both processes use
  the same threshold (`WARP_NEGLIGIBLE_DRIFT_MS` / `kWarpNegligibleDriftMs`).
  Separate ratio epsilons let the engine stretch a near-miss stem while project
  state reported the warp inactive — the same split this ADR forbids for BPM.
- An analysis is a write to the resolved BPM, so it re-derives the warp of every
  unpinned clip already using that item (or inheriting its tempo) and re-broadcasts
  `CLIP_WARP_APPLIED`. Without it the engine kept the ratio built from the old BPM
  while the renderer's beat grid recomputed from the new one — one number, two
  answers again. Timeline beat markers close the loop structurally: a clip warped to
  follow the project tempo takes its marker spacing from the project itself rather
  than deriving it from the ratio, so there is no arithmetic left to disagree.
- **This governs beat *spacing*, not beat *phase*.** A file has one tempo, so every
  clip cut from it is gridded identically — but where beat one falls is a separate
  question, and on variable-tempo material the honest answer genuinely differs
  between two halves of a split. Phase therefore lives on the clip
  (`CLIP.beatOffsetMs`, added to the item anchor by `resolveClipBeatGrid`), and is
  inherited by split, duplicate and paste. Writing it to the shared library-item
  anchor instead — as correcting a clip's grid used to — moved the markers on every
  sibling clip cut from that file while they sat perfectly still, which is the same
  class of "one fact, several owners" defect this ADR exists to prevent, only in the
  opposite direction: phase was being centralised on a fact that is not shared.
