# ADR 0021 — Scratch Editor action patterns

- **Date:** 2026-07-15 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Context

The Scratch Editor lets a user perform a vinyl-style scratch over one timeline
clip or library item, edit the recorded performance as notation, replay it
non-destructively, and bake it into a new library sample. It is unreleased —
built and tested, not yet in a public build.

The feature crosses the MIDI input, real-time audio, project-state, preview,
export, and dialog boundaries at once, so it needs one authoritative contract
for its current behaviour. This ADR describes what exists now. It supersedes
all prior drafts of this decision.

## Decision

### Session and editor ownership

The Scratch Editor is a single, modal, one-session dialog with its own
audition transport. It never seeks, starts, or stops the arrangement
transport. While it is open, global keyboard and MIDI actions are blocked;
input is routed to the active scratch session instead.

The renderer opens and closes the backend session through
`SCRATCH_SESSION_OPEN` / `SCRATCH_SESSION_CLOSE`. Opening accepts exactly one
of a `clipId` or a `libraryItemId` — the editor opens equally from a timeline
clip's context menu or a library item's context menu, including a previously
saved scratch sample. Only one backend session and one shared dialog instance
can be active at a time.

Eligibility to control the session from hardware is scoped to enabled,
supported MIDI inputs and their enabled physical decks. The first eligible
platter touch (or, for movement-only jog profiles, the first movement) claims
the single virtual deck; a capacitive platform's touch sensor is authoritative
over ownership and release. Device disconnect, deck disable, dialog close, or
engine recovery releases ownership and clears held input. Pointer-operated
virtual controls remain available without connected hardware.

### Source preparation and clip semantics

Opening the editor prepares a linear, immutable scratch source snapshot from
the target's source window, reverse, warp, and static pitch settings. This
runs off the audio thread and writes to the existing disk/cache boundary, not
the bridge; a transform fingerprint invalidates the cached snapshot when the
window, reverse, warp, or pitch changes. The scratch stage reads this
snapshot bidirectionally without random-seeking a streaming warp processor.
Clip gain, fades, volume shape, brake, backspin, track/project effects,
automation, mute/solo, and the crossfader all sit downstream of it and are
excluded from the prepared source itself. Mixdown, sample export, and offline
bake share the same preparation path.

The source is linear and bounded: it does not wrap. Movement past either
boundary produces de-clicked silence; reversing back into the valid window
resumes audio. There is no hidden looping.

### Physical MIDI control model

Only the physical **Play** button and the platter/crossfader controls are
mapped inside the editor; the physical **Cue** button is unbound and has no
scratch-editor role (with the editor closed, Cue keeps its ordinary timeline
behaviour unchanged).

Play drives scratch recording, mirroring the on-screen Record button's three
phases: **idle → armed** (press arms; nothing records yet), **armed →
cancelled** (a second press before any touch discards the arm), **recording →
stopped** (a press while recording finalizes the take and publishes the
pattern). Arming does not itself start capture — the **first eligible platter
touch** while armed begins the take, seeking both the scratch source and any
prepared backing bed to zero and starting the recorder with a fresh draft
identity; at that point the recorder resets its lanes and discards any prior
completed draft. Separately, the renderer clears its held draft on the rising
edge of the armed state, so an operator can arm, touch, and start a new take
without an explicit "clear" step — the prior notation disappears on arm, not
only when capture starts or the next take is saved.

The controller guards the auto-stop/toggle race: if the source or backing
window reaches its end and auto-finalizes an in-progress take inside the same
call that is deciding what a Play press means, the press is consumed as that
take's stop rather than immediately re-arming a new one, and a `recordStop`
control that arrives after that auto-finalize is still broadcast as valid
rather than silently dropped, guarded by session id so it can never drain a
different session's pattern.

Engine methods backing this model return `false` when no scratch session is
active, so with the editor closed the same physical events fall through
unchanged to the frontend's ordinary timeline handling; with the editor open
the frontend's interaction block prevents the also-broadcast event from being
applied a second time.

### Direct MIDI-to-audio path; bounded renderer feedback

Backend MIDI decoding feeds eligible scratch controls (platter touch, platter
movement, crossfader, Play) directly into the audio path per raw message,
without a renderer round trip; the renderer never drives scratch audio
timing. Movement arriving while a capacitive platter is not touched is
dropped rather than applied or used to extend ownership, so releasing the
platter returns to motor speed immediately and cannot be delayed by
after-release jog input on touch-equipped decks. A touch-less, movement-only
deck instead infers release after a bounded idle interval and auto-releases
ownership.

Two feedback paths are bounded and coalesced rather than driving audio: the
jog/relative `MIDI_CONTROL` UI echo is throttled to ~30 Hz (per-deck deltas
accumulate and flush on that interval; the underlying scratch motion is
applied per message, unaffected by the throttle), and `SCRATCH_SESSION_STATE`
is emitted at up to half the 60 Hz playhead-timer rate (~30 Hz), only when
status, crossfader, or replay position actually changed, or while playing,
recording, replaying, or touched — otherwise a tick is skipped rather than
re-sent. Raw MIDI input itself is buffered in a fixed-capacity (512-message)
lock-free queue per input; overflow increments an atomic dropped-message
counter that is drained and logged on the message thread each tick, giving
observable back-pressure rather than silent loss or blocking.

### Platter and DSP model

The platter uses a 33⅓ RPM internal timebase: one revolution is exactly 1.8
seconds at nominal speed, and position is continuous, signed, and may move in
either direction; a touched flat position is a hold. Playback is pitch-
changing varispeed (band-limited interpolation), not tempo-preserving warp,
so speed and direction always change pitch together.

Rate response uses two smoothing weights selected by touch state: a heavier,
touched-only ~13 ms manual weight gives light/high-resolution jog wheels a
modest rotational-inertia feel on fast moves, while the release/motor path
uses a fast ~4 ms weight so releasing the platter snaps back to nominal speed
without lag. Touch-off always engages the fast release weight and cancels the
manual hold; gain smoothing and source-boundary fades run on their own
independent, much faster time constants so a touch/release/boundary event
never has to wait on the manual weight to be heard.

### Crossfader

The virtual crossfader controls only the scratch deck's audible gain (the
backing bed, where prepared, sums at its own fixed monitor gain rather than
occupying the fader's opposite side). A stored `linear-v1` gain-curve
identifier keeps replay deterministic. The owning physical deck determines
which side is nominally audible (deck 1 = left, deck 2 = right), and each
device's saved crossfader-direction preference is applied before the gain
calculation; the first physical movement uses catch-up behaviour so an
unknown hardware position cannot jump the gain.

The on-screen bar's colour is a pure function of position and control
source, never of deck ownership or platter touch: while a MIDI device owns
the session it mirrors that device's direction preference; under
keyboard/pointer control it colours by open/closed instead, since the
direction preference is a physical-controller concept the keyboard path does
not have.

A momentary keyboard crossfader cut is available inside the editor: holding a
single configurable key (`KeyZ` default, `KeyM` alternate, chosen in
Preferences) opens the crossfader (scratch deck audible) from a closed
resting default; releasing the key closes it again. The session asserts the
closed default once it becomes controllable, and losing focus or closing the
dialog always forces the fader closed, so a held key can never strand the
deck audible. The cut writes the same `0..1` crossfader value as any other
fader input — it is an input method, not a new recorded field — so while
recording it is captured into the pattern identically to a pointer or MIDI
fader move. MIDI crossfader handling is untouched by this keyboard path.

### Backing accompaniment bed

While the editor is open, the user may prepare a **backing accompaniment
bed** — a fixed-length, pre-rendered mixdown of a chosen set of timeline
tracks — to scratch over for musical context. It is monitor-only: it is never
part of the crossfader, the recorded pattern, or the canonical clip render,
mixdown, or sample-export chain, and it carries no provenance.

- **Selection.** Any subset of tracks may be included; the clip's own owning
  track is excluded by default but may be added back. A track that is muted,
  or silenced by another track's solo, cannot join — it is shown unchecked
  and disabled, using the same effective-audibility test as the mixer, so the
  bed always mirrors what is actually audible on the timeline.
- **Window.** The user picks a start anchor (arrangement start or current
  playhead) and a length of **60, 120, or Full** seconds (default **120**).
  `Full` spans from the anchor to the last clip end of the selected tracks.
  When a backing window is prepared, it becomes the session's forward time
  bound for plain playback and for recording; without one, the scratch
  source's own bounds apply.
- **Preparation and locking.** Preparation is an explicit action, runs off
  the audio thread onto the disk/cache boundary, and is invalidated by a
  fingerprint over the track set, mixdown, and span. The track, anchor, and
  length controls (and Prepare itself) are locked while the bed is playing,
  since a change only takes effect after a fresh prepare; there is no
  separate "clear" affordance in the UI (re-preparing replaces the existing
  bed), though the underlying clear command remains available for teardown.
- **Monitor trims.** Two non-persisted, non-recorded gain trims exist purely
  for audition balance: a backing monitor gain (default 100%) and a scratch
  monitor gain, applied after the crossfader gain (default **85%**, so the
  scratch source sits under the bed by default). Neither is baked, recorded,
  or replayed.
- **Transport.** The on-screen transport (skip-to-start / play-pause /
  skip-to-end) and its `Space` shortcut drive the backing bed only — never
  the scratch source at nominal speed, which is heard only when the platter
  is jogged or during recording. The transport is disabled until a bed is
  ready and while a take is recording. An optional per-session **Loop**
  toggle (off by default) makes plain playback auto-restart the bed at its
  end; loop never applies to recording, which always stops exactly at the
  window's end regardless of the flag. A live position/duration readout is
  always shown, dimmed until a bed is ready.

### Recording and pattern model

A completed recording is compact action data, not rendered audio: a stable
id, name, format version, optional source provenance, an integer-microsecond
duration and crop range, the source offset and platter position at the
cropped start, platter keyframes (time, absolute turns, touch state),
crossfader keyframes (time, normalized value), the owner deck, and the
`linear-v1` curve identifier. Forward/reverse motion is the slope between
platter keyframes; a touched flat span is a hold. Device-specific jog
calibration converts raw controller units to the internal turn timebase
before recording, so a pattern is controller-independent and replays
identically without its original hardware. Redundant points may be simplified
within a tested audible tolerance; the resulting pattern, not the unsaved
live gesture, is the source of truth thereafter.

The notation panel is a direct, editable view of the same lanes (platter
motion segments, holds, and a crossfader automation lane); editing it mutates
the action data and is undoable, and cropping rebases time to zero while
preserving source offset.

A recording is **transient draft state** in the audio engine until the take
is stopped; only a completed pattern becomes additive, backend-authoritative
project state, held in the `SCRATCH_PATTERNS` `ValueTree` and written through
the versioned project-JSON path (validated on write and revalidated on
serialization, with corrupt entries dropped rather than propagated). A
timeline clip may non-destructively reference a saved pattern; a shorter
source at apply time uses the same boundary-silence rule rather than
wrapping or stretching. Engine loss during recording aborts the in-progress
take rather than presenting it as complete; a saved pattern is covered by
normal project save, autosave, undo, and recovery.

### Replay

Auditioning a completed pattern ("Play Scratch",
`SCRATCH_PATTERN_REPLAY_START`/`_STOP`) is independent of the arrangement and
backing transports: it neither issues nor depends on a transport `play`/
`pause` action, so it works with or without a prepared backing bed and never
disturbs backing playback that is already running. When a backing bed is
ready, replay additionally rewinds it to its head and plays it in lock-step,
because a take always begins with both the scratch source and the bed seeked
to zero, so replaying the bed from its head reproduces the alignment heard
while recording; with no bed ready, replay is scratch-only.

Replay publishes a normalized replay position that drives two live playheads
— the waveform playhead (via the ordinary scratch-source position) and a
green sweep line on the notation panel (position mapped back through the
pattern's crop range) — at the same throttled session-state rate. Platter
touch/move and crossfader input are rejected outright while a pattern is
replaying, so a live gesture can never collide with the deterministic
playback it is auditioning. Ending replay (naturally or by request) stops and
rewinds any synced backing, clears the replay position, and resets touch/
manual scratch state so the session returns to its ordinary interactive
state.

### Save to the library

Saving bakes the recorded pattern over its prepared source into a frozen
stereo WAV (`SCRATCH_SAVE_AS_SAMPLE`), driving the same DSP evaluator used
for live replay so the bake matches what was heard. The canonical
performance stays the notation already persisted in the project `ValueTree`;
the bake is a derived, replaceable artifact.

The result is an ordinary `kind="sample"`, unanalysed `audioType="simple"`
library item — draggable to the timeline, still warp/pitch-able — plus
additive scratch metadata: `scratchPatternId` (link to the canonical
notation) and `scratchSourcePath` (a self-contained copy of the exact source
window the scratch was performed over, written once beside the bake). A
generated `notation.json` mirrors the ValueTree notation for external
inspection only and is never read back as a source of truth. Each save
writes a new immutable revision file and atomically repoints the library
item, so a re-save can never overwrite bytes a placed clip is still reading.
When the scratch was recorded over another library item, the baked item
inherits that source's shared media entry so cover art resolves normally,
and the exact source window (offset/duration) is stored so re-opening can
show the original context rather than the already-scratched audio.

A baked scratch sample carries **no** live pattern reference on any placed
clip — dropping one onto the timeline always plays the frozen audio, never
re-scratches on playback. The pattern link exists only as re-open metadata on
the library item: "Open in Scratch Editor" on a scratch-origin item prepares
the session from `scratchSourcePath` (not the baked WAV) and loads the linked
notation for further editing and re-saving in place. Scratch-origin items are
visually distinct in the library — a dedicated vinyl-record icon and a
"Scratch" type badge — rather than reusing the generic sample tile. No new
library-item kind was introduced, so older builds that predate this feature
still open the item as a plain sample.

### Project lifecycle

A new project, a successful project load, and a successful crash-recovery
load all clear any active scratch session, its backing bed, and any running
replay in the engine before rebuilding tracks, and the renderer mirrors this
by closing the scratch editor dialog and clearing its session store whenever
it receives a `PROJECT_STATE` reset snapshot. A **failed** load leaves the
current scratch session untouched in both processes — the clear only runs
after the new project has been accepted, so a load failure can never strand
a project reference to a session that no longer matches what is on screen.

### Real-time, threading, and error handling

The audio callback never allocates, locks a session mutex, logs, touches
disk, or sends over the bridge; scratch and backing audio reach it only
through lock-free snapshots and atomics. Session control, MIDI entry points,
recording, and backing/source preparation orchestration run on the message
thread (or, for MIDI, the MIDI thread with the same lock-free contract);
source preparation, backing mixdown, and the sample bake run on background
worker-pool jobs, each guarded by a session-id check so a stale job's
completion is silently ignored rather than applied to a session it no longer
belongs to. Malformed or out-of-range bridge payloads are rejected by parse
functions before reaching engine state; preparation or bake failures set an
error status and degrade to silence rather than partial or corrupt audio.

### Test invariants and maintainability

Backend coverage exercises session lifecycle and deck ownership, source
preparation/caching and reuse, activation/deactivation quiescence, forward-
end auto-stop and race-guarded record toggling, MIDI crossfader and platter
claim/release semantics (including jog calibration and direction inversion),
pointer and MIDI arm-on-touch recording, backing prepare/loop/replay-sync
behaviour, replay input isolation, and `clearScratchSession` teardown of
replay and backing together. Separate suites cover pattern persistence
(CRUD, malformed-input rejection, JSON round-trip, undo) and clip-pattern
apply/remove/replay project-state behaviour. Frontend coverage mirrors the
same invariants for record-control state, transport gating, pointer
dispatch, replay position/gating, project-reset clearing, and pattern
protocol/persistence reconciliation.

The backend and frontend scratch code are both split by domain — separate
units for protocol, session control, MIDI routing, recording, backing,
persistence, save-as-sample, and, on the frontend, one composable/component
per concern (dialog shell, waveform, notation lanes, platter/crossfader
controls, transport, backing, save flow, reopen lifecycle, replay) — so that
adding a capability extends one focused unit rather than growing a single
large file past ADR 0016's ceilings.

## Why

A dedicated, modal session keeps a large, high-rate control surface from
moving the arrangement playhead or leaking past the application's dialog
gate. Feeding eligible MIDI directly into the audio path, with only display
feedback throttled, keeps the highest-rate control loop short while still
giving the renderer everything it needs to mirror state. Recording compact,
controller-independent action data — rather than raw audio or raw events —
is what makes the performance editable, replayable, and renderable through
the same deterministic evaluator live and offline. Treating the backing bed
as a monitor-only, pre-rendered bus, and baking a saved scratch to a plain
WAV rather than a live-evaluated clip, both keep the canonical render chain
and non-destructive editing model exactly as simple as they are everywhere
else in the project — no second live mixing surface, and no per-clip scratch
DSP on ordinary playback.

## Consequences

- Scratch playback needs its own bidirectional varispeed source and a
  dedicated recorder/evaluator, independent of the arrangement's warp/scrub
  paths.
- MIDI routing carries an explicit scratch-session owner and a direct,
  bounded feedback throttle alongside the existing profile-driven
  architecture.
- Project state and the bridge carry a versioned scratch-pattern domain plus
  additive library-item scratch metadata; both are backward-compatible with
  older projects and builds.
- The canonical clip render, mixdown, and sample-export chain gained one more
  input path (pattern-driven scratch playback) without changing for clips
  that carry no pattern.
- Saving a scratch produces a first-class, draggable library asset with no
  live per-clip evaluation cost, at the price of a bake step and one
  self-contained source-snapshot file per scratch.

## Rejected alternatives

- **Send scratch MIDI through the renderer before it reaches audio.** The
  extra scheduling and bridge round trip would add avoidable jitter to the
  highest-rate control path; direct backend consumption keeps it short.
- **Persist raw MIDI/pointer events instead of simplified action keyframes.**
  Raw events are not controller-independent, cannot be simplified or edited
  meaningfully, and would make deterministic offline replay much harder.
- **Let the scratch source wrap at its boundaries.** Hidden looping would
  change the recorded gesture and make a pattern's meaning depend
  unpredictably on source length; boundary silence with no wrap keeps replay
  a faithful record of what was performed.
- **Give a placed clip a live `scratchPatternId` that re-scratches on
  playback**, instead of baking a frozen sample. Live evaluation on ordinary
  timeline playback would add per-clip scratch DSP cost project-wide, risk
  double-applying a pattern, and produce a less portable, self-contained
  asset than a plain WAV with re-open metadata.
- **Route the backing bed through the crossfader's opposite side, or bake it
  into the recorded pattern or exported sample.** Either would turn the
  bed into part of committed output or the deterministic fader model,
  breaking the monitor-only, non-destructive guarantee the bed exists to
  provide.
- **Leave a scratch session alive across a project reset, new project, or
  load.** A stale session could reference a clip or library item from a
  project that no longer exists in the engine or the renderer; clearing it
  on every reset (and only on a *successful* load) keeps both processes
  pointed at the same project.
- **Accept platter, crossfader, or MIDI touch input while a pattern is
  replaying.** Replay is a deterministic audition of already-recorded data;
  allowing live input to reach the same source during it would make replay
  timing depend on unrelated real-time interaction instead of the stored
  pattern.
