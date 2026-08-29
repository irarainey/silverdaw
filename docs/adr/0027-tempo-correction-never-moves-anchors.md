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
  `98.80 / 102.76`, about 4% *slow*. The field is also reachable only from a clip
  already on the timeline, which is precisely the point at which the project has
  already been seeded from the wrong number.

The shape of the gap is that every tempo control expresses a **musical**
intent — change what the arrangement runs at — and none expresses a
**corrective** one. The fix has to be reachable on the *file*, in the library,
before it is arranged: correct it there and `maybeSeedProjectBpmFor` seeds the
project from the right number when the first clip lands, so the common case
needs no second step at all.

## Decision

Correcting a mis-detected tempo is a distinct operation from changing the
arrangement's tempo, and the line between them is drawn at persisted position:

> A correction never moves a **persisted absolute timeline anchor** — a clip
> start, a marker, an automation point, a timeline selection or the playhead.
> **Tempo-derived and clip-local geometry may change**, and is reconciled from
> the final corrected state.

The narrow wording is deliberate, because the broad version is unkeepable. A
correction re-derives the ratio of every clip that follows the corrected tempo,
and therefore their drawn and played lengths; clip volume shapes are measured
across a footprint and must scale with it; transitions may cease to have a valid
overlap. Everything derived from the tempo moves when the tempo is corrected.
What must not move is anything the user placed.

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

**It never touches the project tempo.** Setting the project tempo from the first
clip dropped is **merely a convenience, with no linkage and no history.**
`maybeSeedProjectBpmFor` copies a number once and returns early ever after;
nothing records that it happened, nothing ties the project tempo to the item it
came from, and that item may since have been moved, replaced, deleted from the
timeline or removed from the library altogether. The project tempo is simply the
user's number, and a statement about a file is not evidence about it.

Equality between the project tempo and the item's pre-correction BPM is not
evidence either — several tracks can share a detected tempo, and a user may have
typed that exact value deliberately. `handleProjectSetBpm` sets `bpmSeeded`
without distinguishing a hand-typed tempo from an automatic seed, so the flag
cannot answer it either. There is therefore no question to ask, and the command
writes exactly one tempo fact.

The consequence, when the project tempo was already seeded from the wrong number
and the clip is on the timeline, is that the clip then warps by `98.80 / 102.76`
— and that is warp working correctly rather than a residual bug. Before the
correction the two numbers were the same wrong number, so the clip happened to
warp by 1.0; afterwards the file tells the truth and a project running at 98.80
genuinely has to slow it down to fit. Setting the project tempo to 102.76 in the
transport box unwarps it again. Both steps are honest edits with visible,
separately undoable effects, and the user only reaches the second if they
actually want the arrangement to run at the corrected tempo.

Correcting the file in the library *before* placing the first clip avoids the
second step entirely, because `maybeSeedProjectBpmFor` then seeds from the
corrected number — and the library is where the correction is offered.

The alternative — offering to carry the correction into the project — is a real
trade-off rather than a free improvement, because a clip from another source
that was snapped to bar 9 keeps its millisecond start while bar 9 itself moves
(at 98.80 BPM bar 9 sits at 19433 ms, at 102.76 BPM at 18684 ms), so a clip that
was on the grid comes off it. Two clearly separated edits are simpler to
understand and to undo than one edit with a consequential option attached
(ADR 0011).

Provenance — recording which item seeded the project tempo — is **not** part of
this decision. It would buy a pre-selected default with a lifecycle obligation
across manual edits, relink, source removal, project import ID remapping, undo
and persistence, and it would frequently point at an item that is no longer in
the project. Origin is also not continuing intent: a user may have accepted a
seeded tempo as their arrangement's tempo long ago.

**It is one backend command.** A single command validates once, writes the
source tempo, reconciles every affected clip ratio, envelope and transition from
the final state, and broadcasts one consistent result.

**It reports what it did and what it did not touch.** Clips updated; clips
excluded because their ratio is pinned or their warp is off — exclusions by the
user's own earlier choice, not failures; transitions invalidated; new overlaps
or gaps; any clip now extending past the persisted project length.

Nothing here changes ADR 0024. There is still one source BPM per item and one
warp target per clip, resolved by the same two functions.

**"Correction" is not product vocabulary the user must learn.** They see one
action, *Edit BPM*, on the library item; the project tempo box keeps its
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

Leaving the project tempo out of the command entirely, rather than deducing or
asking about it, is both the safe answer and the simple one (ADR 0011). No
available signal actually distinguishes "a number that was only ever an echo of
this detection" from "the tempo I have been arranging to", so a rule that
guesses would be right often enough to be trusted and wrong destructively. And
asking has its own cost: it makes a one-number edit into a decision with a
consequence the user has to reason about, at the exact moment they are least
equipped to — they have just discovered the software got a number wrong. One
edit, one number, one undo is the version they can predict.

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
- **The action must be offered wherever the wrong number is read.** The decision
  is about intent, not about one control, and the number that provokes the fix is
  read in several places. Implementation confirmed how easily this is missed: the
  Clip Editor renders its per-clip effects rack only for an existing clip, so
  putting the affordance in the beat grid alone made it reachable only from a clip
  already on the timeline — the opposite of an action on the source. The surfaces
  are therefore a dedicated **Edit BPM** dialog, reached from the library context
  menu's **Edit BPM…** or from the Edit button beside the BPM on the item's
  information dialog, and the Clip Editor opened on a timeline clip. The
  information dialog itself stays read-only: it states what a file is, while
  editing is a transaction that needs a Cancel and a Save, and mixing the two left
  it ambiguous which control wrote anything. The Clip Editor opened on a *library
  source* deliberately carries no grid editor: that window chooses a section to
  save and has no Save of its own to commit a file-level edit, so offering one
  there would have been a third meaning rather than a third route. The two real
  surfaces share one presentational component so the consequences are worded
  identically, and one command, so neither can drift into a different meaning.
- **Beat markers need no separate treatment.** They are already synthetic:
  `resolveSourceBeatGrid` spaces them at `60000 / bpm` phase-locked to
  `beatAnchorSec`, and the detected `beats` array is consulted only for presence
  and as a legacy anchor fallback. Correcting the tempo therefore respells the
  grid by construction. Phase is a separate fact and is deliberately not touched:
  a correction from the library carries the owner's existing anchor, so fixing a
  number can never slide the grid of every clip cut from that file. Phase is
  corrected where it can be seen, in the Clip Editor's Position control.
- **No clip is ever aligned to the grid as part of a correction.** With the
  project tempo untouched, the bar lines do not move, so nothing can be knocked
  off them and there is no phase to repair. The invariant is absolute, with no
  exception clause, which is what the journey test asserts.

## Rejected alternatives

- **Offer to carry the correction into the project tempo.** The original
  decision here, and removed: it presents a consequential trade-off at the worst
  moment. Carrying respaces the bar lines underneath clip starts that have not
  moved — at 98.80 BPM bar 9 sits at 19433 ms, at 102.76 BPM at 18684 ms — so a
  clip from another source that was snapped to bar 9 comes off it, which then
  needs a second opt-in to align clips back to the grid. That is three coupled
  decisions hanging off one number. Because seeding the project tempo is a
  one-time convenience, the project number is the user's and the transport box
  already changes it, so the whole branch buys nothing that the two separate,
  individually undoable edits do not.
- **Promise that a correction changes nothing audible.** The first draft of this
  ADR, and false. Clips following the corrected tempo re-derive their ratio by
  construction — that is the fix — and their lengths change with it.
- **Promise that a correction "never retimes".** The second draft, and still too
  broad: beat-repeat windows are beat-anchored, clip envelopes must scale with
  their footprint, transition boundaries move and clip ends move. Only persisted
  absolute anchors can actually be held still.
- **Infer a project-tempo carry from `projectBpm == oldSourceBpm`.** Presented
  as narrow and safe; it is neither. It fires on a coincidental match between two
  imports, on a tempo the user typed deliberately, and on stale state after a
  relink, and it fails whenever the value was rounded or re-entered near rather
  than exactly at the detected one.
- **Persist which item seeded the project tempo.** Sound evidence of origin, but
  it buys only a default, at the cost of a full provenance lifecycle. Origin is
  also not continuing intent: a user may have accepted a seeded tempo as their
  arrangement's tempo long ago.
- **A flag on `PROJECT_SET_BPM`.** Fewer moving parts, but it makes retiming the
  conditional part of the one path that must always retime, and it is invisible
  to the type-string switches that drive undo grouping, undo labelling and
  transition geometry.
- **Two commands, source then project, in one undo group.** Moot now that a
  correction writes one tempo fact, but recorded because it was the shape this
  nearly took. `EDIT_GROUP_BEGIN` / `EDIT_GROUP_END` gives one undo press but is
  transaction coalescing, not atomic validation: the source half can land and the
  project half be rejected, leaving a partial correction. It also broadcasts and
  plays an inconsistent intermediate state.
- **Always move the project tempo with a source correction.** Predictable until
  a project draws its tempo from one track and its material from several, where
  correcting any file drags the whole arrangement onto it.
- **Reset a corrected item back to its detected tempo.** A third state to hold
  and explain, for something re-running analysis on the file already does.
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
