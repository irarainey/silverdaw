# ADR 0027 — Correcting a mis-detected tempo never moves an absolute timeline anchor

- **Date:** 2026-08-29 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Context

Tempo detection is a guess, and it is sometimes wrong by a few percent. A file
that is really around 103 BPM is detected as 98.80, and the user notices only
once the arrangement is under way.

The miss that matters is not the octave error. A halved or doubled tempo is
already served by the ÷2 / ×2 buttons in the Clip Editor, and it is obvious on
sight. The damaging case is the few-percent one: the material is nearly right,
drifts audibly over a bar or two, and the correct answer is a number the user
knows from outside Silverdaw rather than one the app can derive. Independent
tools disagree in exactly this band on the same file, so there is no arithmetic
relationship to a detected 98.80 that the product could offer as a suggestion —
only a value the user types in.

Two facts hold a tempo, and ADR 0024 already settles who owns each:

- the **source BPM** on the library item, resolved by `libraryItemSourceBpm` and
  `ProjectState::getLibraryItemBpm` — what the file actually is;
- the **project BPM** on `ProjectState` — what the arrangement runs at.

A clip that follows the project plays at `projectBpm / sourceBpm`. A
mis-detection is an error in the **source** fact. But `maybeSeedProjectBpmFor`
copies the first musical clip's detected tempo into the **project** fact as
well, so one wrong number lands in two places and the user has no way to tell
that the second is only an echo of the first.

Neither control that exists today expresses the correction:

- Editing the project tempo box runs `handleProjectSetBpm`, which reads the edit
  as a *musical* instruction. It rescales the arrangement to preserve its
  musical shape — `retimeClipsForTempoChange`, `retimeMarkersForTempoChange`,
  `retimeTrackAutomationForTempoChange`, and the playhead by
  `previousBpm / bpm` when both tempi are positive, differ, and the playhead is
  past zero — then re-derives the ratio of every clip that is warp-enabled and
  unpinned. Under the auto-warp preference it first *enables* warp on unwarped
  clips that have a source tempo. The user's clip then plays at
  `102.76 / 98.80`, about 4% fast, and every position in the project has moved
  in milliseconds. Correct for its own intent; the opposite of the user's.
- The Clip Editor's Tempo field (`ClipEditorBeatGridPanel` →
  `applyManualTempo`) does correct the source fact. But seeding is one-shot —
  gate 2 of `maybeSeedProjectBpmFor` returns early once `isBpmSeeded()` is
  true — so the project stays at 98.80 and the same clip now plays at
  `98.80 / 102.76`, about 4% *slow*. One wrong warp is exchanged for another,
  and to a user who has just typed the right number that reads as the fix having
  made things worse.

Doing both, source first, does reach the right destination, but the project-BPM
step rescales the arrangement on the way and later correcting the source does
not undo it. Turning warp off is not an escape either: the re-derivation loops
skip clips that are not warp-enabled, so the audio plays dry under a beat grid
still spaced from the wrong source BPM. That is wrong grid metadata over honest
audio rather than the renderer/engine split ADR 0024 guards against, but it is
still a clip the user cannot line anything up against.

The shape of the gap is that every tempo control expresses a **musical**
intent — change what the arrangement runs at — and none expresses a
**corrective** one.

## Decision

Correcting a mis-detected tempo is a distinct operation from changing the
arrangement's tempo, and the line between them is drawn at persisted position:

> A correction never moves a **persisted absolute timeline anchor** — a clip
> start, a marker, an automation point, a timeline selection or the playhead.
> **Tempo-derived and clip-local geometry may change**, and is reconciled from
> the final corrected state.

The narrow wording is deliberate, because the broad version is unkeepable. A
correction that moves the project tempo re-derives the ratio of every clip
following it, and therefore their drawn and played lengths; clip volume shapes
are measured across a footprint and must scale with it; transitions may cease to
have a valid overlap; the metronome, tempo-synchronised VST3 plugins
(`AudioEngine::setMetronomeBpm` also drives `pluginPlayHead`) and beat-repeat
regions all follow the project tempo. Everything derived from a tempo moves when
the tempo is corrected. What must not move is anything the user placed.

The operation is defined as follows.

**It targets the resolved tempo owner, not the selected item.** ADR 0024 rules 2
to 4 mean the tempo shown for an item may be its own BPM, a value calculated
from its recorded `musicalBeats`, or one inherited from the item it was cut
from. The command resolves and returns both an **owner** and a **resolution
reason** (`musicalLength` / `ownBpm` / `inheritedBpm`), because the three need
different handling: an inherited tempo is corrected on the ancestor so every
sibling is fixed at once, while a `musicalBeats` tempo is a measurement that a
correction would discard. Today neither resolver walks a chain — both
`libraryItemSourceBpm` and `ProjectState::getLibraryItemBpm` look at the item
and at most its direct source, and read that source's raw BPM without applying
their own precedence to it. Owner resolution therefore needs a shared,
cycle-safe definition in both processes rather than an appeal to recursion that
does not currently exist.

**It is explicit about a recorded musical length.** `musicalBeats` outranks a
detected tempo under ADR 0024 because it is a measurement rather than an
opinion, and setting a manual tempo discards it, which can change the item's bar
length and every clip cut from it. When the resolution reason is
`musicalLength`, the user is told that before it happens.

**Whether the project tempo moves is always the user's explicit answer.** The
command asks, with the consequence stated, and never infers. Equality between
the project tempo and the item's pre-correction BPM is not evidence — several
tracks can share a detected tempo, and a user may have typed that exact value
deliberately. `handleProjectSetBpm` sets `bpmSeeded` without distinguishing a
hand-typed tempo from an automatic seed, so the flag cannot answer it either.
Equality may decide how prominently the option is offered; it may not decide the
answer.

**Carrying the project tempo is a real trade-off, not a free improvement.** It
must be presented as one, because a clip from another source that was snapped to
bar 9 keeps its millisecond start while bar 9 itself moves — at 98.80 BPM bar 9
sits at 19433 ms, at 102.76 BPM at 18684 ms — so a clip that was on the grid can
come off it. The three outcomes are distinct and the user chooses between them:

- **Correct the source only** — the project grid and every placement stay put;
  that source's clips re-warp onto the unchanged project tempo.
- **Correct the source and carry the project tempo** — absolute placements stay
  put and the grid is corrected, but material arranged against the old grid may
  no longer line up with it.
- **Change the project tempo** (the existing tempo box) — bar and beat
  placements are preserved and absolute positions move.

Provenance — recording which item seeded the project tempo — is **not** part of
this decision. Once carrying requires an explicit answer, provenance only
pre-selects a default, and it would buy that with a lifecycle obligation across
manual edits, relink, source removal, project import ID remapping, undo and
persistence. Origin is also not continuing intent: a user may have accepted a
seeded tempo as their arrangement's tempo long ago.

**It is one backend command.** A single command validates once, applies the
source and project tempo in a defined order, reconciles every affected clip
ratio, envelope and transition from the final state, and broadcasts one
consistent result. It is the only operation permitted to write both tempo facts.

**It reports what it did and what it did not touch.** Clips updated; clips
excluded because their ratio is pinned or their warp is off — exclusions by the
user's own earlier choice, not failures; transitions invalidated; new overlaps
or gaps; any clip now extending past the persisted project length.

Nothing here changes ADR 0024. There is still one source BPM per item and one
warp target per clip, resolved by the same two functions.

**"Correction" is not product vocabulary the user must learn.** They see one
action, *Correct detected tempo*, on the source; the project tempo box keeps its
existing meaning. The distinction in this ADR is for the code.

## Why

The two intents are different edits that happen to move the same numbers, so
they need different operations rather than one operation with a mode. "Play the
arrangement faster" preserves musical positions and therefore must move
milliseconds; "the detector was wrong" preserves milliseconds and therefore must
not move musical positions. Neither is a special case of the other, and asking
one path to be both would put the retiming calls behind a condition — exactly
the branch that goes stale.

Defining the operation by persisted anchors, rather than by sound or by any
broader notion of movement, is what makes it truthful. The project tempo is a
live input to the metronome, the plugin playhead, beat-repeat and every
following clip's ratio; anything that moves it is audible by construction, and a
clip whose ratio changes changes length, which cascades into envelopes,
transitions and export bounds. An invariant the implementation cannot honour is
worse than none, because the next contributor will believe it.

Asking about the project tempo, rather than deducing it, is both the safe answer
and the simple one (ADR 0011). The user is not required to learn that a tempo
lives in two places — only to answer a question about their own project, with
the consequence in front of them. No available signal actually distinguishes "a
number that was only ever an echo of this detection" from "the tempo I have been
arranging to", and a rule that guesses would be right often enough to be trusted
and wrong destructively.

## Consequences

- A correction is one action with one undo. Clip starts, markers, automation,
  the timeline selection and the playhead are untouched. Beat grids, following
  clips' ratios and lengths, clip envelopes, transitions, the metronome,
  tempo-synced plugins and beat-repeat all re-derive.
- **Clip envelopes scale with their clip's footprint.** The command snapshots
  footprints and calls `retimeClipEnvelopesForFootprintChange` after final
  ratios are reconciled, exactly as the tempo-change path does. Envelope
  breakpoints are clip-local milliseconds; leaving them fixed while the clip
  lengthens would shape different audio, which is the outcome the invariant's
  "clip-local geometry" clause deliberately permits and requires.
- Footprint changes can create or remove overlaps and gaps, invalidate
  transitions, and push a clip past the persisted project length, which is
  independent and not auto-updated. Transition reconciliation must run after
  every final ratio is visible in `ProjectState`, within the same undo
  transaction, and the renderer and export dialog need the updated effective
  durations immediately.
- The undo entry is not free. The new message type must be added to
  `isUndoableEnvelopeType` and `prettyTransactionName` in `UndoCommands.cpp`,
  and to `transitionGeometryMayHaveChanged` in `TransitionCommands.cpp` —
  registering it is what routes reconciliation and `syncClipEdgeFades`.
- `applyManualTempo` matches dependants only by the item itself or one direct
  `sourceItemId`, so the shared owner-resolution work above is a prerequisite,
  not an optimisation.
- A correction must not seed a project that has not been seeded. Seeding stays
  the job of `maybeSeedProjectBpmFor` on the first musical clip; correcting a
  library-only item with nothing on the timeline changes the source fact alone.
- The command needs a defined failure response so the renderer can roll back its
  optimistic local draft and say what was not applied, rather than leaving the
  project half-corrected. Wire compatibility is its own concern: a new outbound
  message reaching an older backend is simply unhandled, which persisted-state
  compatibility does not cover (ADR 0019, ADR 0004).
- Two things are deliberately **out of scope** and should be taken separately:
  flagging a `lowConfidence` detection at the moment it seeds the project — the
  cheapest place to catch this error, but a detection-confidence question with
  its own threshold, placement and confirmation decisions — and a named
  "override this derived item only" action, which is advanced semantics and
  reintroduces the two-concept burden this decision exists to avoid. The
  existing Clip Editor field already provides the lower-level capability.
- Still to be settled when this is built: behaviour when a correction is applied
  during playback, and export parity immediately afterwards.

## Rejected alternatives

- **Promise that a correction changes nothing audible.** The first draft of this
  ADR, and false. Any second source following the project tempo re-derives its
  ratio when the project tempo moves, and the metronome, plugin playhead and
  beat-repeat follow it too. Keeping the promise would mean refusing the carry
  in any mixed arrangement, abandoning the common case, or pinning every
  existing effective ratio first, which silently converts follow-project clips
  into pinned ones — a far larger semantic change than the problem warrants.
- **Promise that a correction "never retimes".** The second draft, and still too
  broad: beat-repeat windows are beat-anchored, clip envelopes must scale with
  their footprint, transition boundaries move and clip ends move. Only persisted
  absolute anchors can actually be held still.
- **Infer the carry from `projectBpm == oldSourceBpm`.** Presented as narrow and
  safe; it is neither. It fires on a coincidental match between two imports, on
  a tempo the user typed deliberately, and on stale state after a relink, and it
  fails whenever the value was rounded or re-entered near rather than exactly at
  the detected one.
- **Persist which item seeded the project tempo.** Sound evidence of origin, but
  once the carry must be confirmed anyway it only pre-selects a checkbox, at the
  cost of a full provenance lifecycle. Origin is also not continuing intent, so
  it would pre-tick the carry in exactly the established multi-source project
  where carrying is most likely to break someone's alignment.
- **A flag on `PROJECT_SET_BPM`.** Fewer moving parts, but it makes retiming the
  conditional part of the one path that must always retime, and it is invisible
  to the type-string switches that drive undo grouping, undo labelling and
  transition geometry.
- **Two commands, source then project, in one undo group.** `PROJECT_SET_BPM`
  would repair the intermediate ratio, so that is not the objection.
  `EDIT_GROUP_BEGIN` / `EDIT_GROUP_END` gives one undo press but is transaction
  coalescing, not atomic validation: the source half can land and the project
  half be rejected, leaving a partial correction. It also broadcasts and plays
  an inconsistent intermediate state, and it can only reach the project tempo
  through the retiming path this operation exists to avoid.
- **Correct only the source and let the user fix the project tempo.** Today's
  behaviour with better signposting. It leaves the clip warped by the same error
  inverted, and the project-tempo step still rescales the arrangement.
- **Always move the project tempo with a source correction.** Predictable until
  a project draws its tempo from one track and its material from several, where
  correcting any file drags the whole arrangement onto it.
- **Re-run detection, or offer the derived candidates.** Detection is what was
  wrong, and a second opinion from the same detector on the same audio is not
  evidence. Offering halves, doubles and thirds does not reach the answer
  either, because the failure being corrected is a few-percent miss with no
  arithmetic relationship to what was detected; the octave case those candidates
  would cover is already served by ÷2 / ×2.
- **Let the user type the project tempo and infer the correction from it.**
  Ambiguous by construction — the same keystroke means "this file was
  mis-detected" and "play my arrangement faster".
- **Store the detected tempo and the corrected tempo separately on the item.** A
  second copy of one fact, which ADR 0024 forbids; a correction is a write to
  the tempo, not a competing opinion beside it.
