# ADR 0021 — Scratch Editor action patterns

- **Date:** 2026-07-12 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

## Context

The Scratch Editor will let a user perform a vinyl-style scratch over one
selected timeline clip, edit the recorded performance, replay it
non-destructively, and render it as a new library sample.

This crosses the MIDI input, real-time audio, project-state, preview, export,
and dialog boundaries. The feature needs one contract before its DSP and user
interface are implemented.

## Proposed decision

### Session and input ownership

The Scratch Editor is a large modal dialog with its own audition transport. It
does not seek, start, or stop the arrangement transport.

While the editor is open:

- Timeline and global keyboard and MIDI actions remain blocked.
- Scratch controls are routed to the active scratch session rather than
  weakening the application-wide dialog gate.
- Only enabled, supported MIDI inputs and their enabled physical decks are
  eligible.
- The first eligible deck used claims the single virtual deck. It retains
  ownership until its platter is released.
- A deck without touch messages releases ownership after a short bounded idle
  interval.
- Device disconnect, deck disable, dialog close, or engine recovery releases
  ownership and clears held input safely.
- Pointer-operated virtual controls remain available so the editor can be
  developed and opened without connected hardware.

The availability predicate for a supported enabled deck will exist from the
first version, but it will not initially hide or disable the context-menu
action.

The renderer opens and closes the backend session through typed
`SCRATCH_SESSION_OPEN` and `SCRATCH_SESSION_CLOSE` bridge commands. The backend
already owns enabled-input and deck-selection state; it uses that state to
determine eligibility and claim an owner from the semantic MIDI stream.

While a session is active, backend MIDI decoding feeds eligible scratch
controls to it directly rather than making a
backend-to-renderer-to-backend round trip. Existing `MIDI_CONTROL` telemetry may
still update renderer device state, but the dialog gate prevents it from
reaching global actions. The backend emits throttled, display-only
`SCRATCH_SESSION_STATE` updates. Pointer controls use a typed
`SCRATCH_SESSION_CONTROL` command. The renderer never drives audio timing.

Touch-capable profiles claim on touch or a deck-specific session action and
release on touch-up. Movement-only jog profiles claim on movement and infer
release after a bounded idle interval; they cannot represent an indefinite
stationary hold. The 1.8-second revolution is an internal source-time model,
not a claim that every physical jog wheel is record-sized or motorized.

### Clip and transport semantics

Opening the editor prepares a seekable scratch source from the selected clip's
current source window, reverse, warp, and static pitch settings. Preparation
runs off the audio thread and writes bulk audio to the existing disk/cache
boundary rather than the bridge. The scratch stage can then read this linear
prepared source bidirectionally without random-seeking a streaming warp
processor.

The canonical order for a clip carrying a pattern is:

1. Source window, reverse, warp, and static pitch prepare a linear source.
2. The scratch trajectory performs bidirectional varispeed reads.
3. Clip gain, fades, volume shape, brake, and backspin process the resulting
   forward timeline stream.
4. Track and project processing continue through the existing graph.

The prepared source excludes track effects, project effects, automation,
mute/solo state, and the crossfader. A transform fingerprint invalidates it
when the source window, reverse, warp, or pitch changes. Mixdown and sample
rendering prepare the same source before rendering.

The local Play control runs the platter at its nominal speed. Touching the
owning platter holds the motor; hand movement then controls source direction
and speed. Releasing it returns smoothly to nominal playback. Scratch audition
always produces scrub audio and does not read the main-timeline scrub-audio
preference.

The scratch session starts stopped. Recording starts from the current crop
start and captures actions against the local session clock. Auditioning or
recording never changes the selected clip until the user explicitly applies or
saves the result.

The source does not wrap at its boundaries. Movement beyond the prepared source
produces de-clicked silence. Reversing back into the valid window resumes audio.

### Platter and audio model

The platter uses a 33⅓ RPM internal timebase:

- One revolution is exactly 1.8 seconds at nominal speed.
- Platter position is continuous and may move forward or backward.
- Position slope determines playback direction and varispeed ratio.
- A touched flat position is a hold.
- The visual sweep line is derived from authoritative platter position modulo
  one revolution.

Scratch playback is pitch-changing varispeed, not tempo-preserving warp. The
DSP must use band-limited interpolation or resampling, smooth acceleration and
direction changes, suppress clicks near zero speed and at source boundaries,
and cap speeds that cannot be reproduced cleanly.

The DSP prototype will select the interpolation method and maximum supported
speed from measured quality and callback cost. These values are not fixed by
this ADR.

### Crossfader

The virtual crossfader starts with the claimed deck fully audible. The first
physical movement uses the existing catch-up behavior so an unknown hardware
position cannot cause an abrupt gain jump.

The owning physical deck determines the audible side:

- Deck 1 is the left side.
- Deck 2 is the right side.
- The device's saved crossfader-direction preference is applied before the
  deck-side gain calculation.

The opposite side contains silence, so the crossfader controls only the
virtual deck's gain. Version 1 uses a stored `linear-v1` gain curve. Persisting
the curve identifier keeps replay deterministic if more mixer curves are added
later. Recordings capture the effective post-catch-up fader value. This audible
behavior is scoped to the Scratch Editor; it does not change the crossfader's
arrangement behavior.

### Action pattern

A recording stores compact action data, not rendered audio and not every audio
sample. The versioned pattern contains:

- A stable identifier, name, format version, and optional source provenance.
- Duration and crop range on an integer monotonic timebase.
- The source offset and platter position at the cropped start.
- Platter keyframes containing time, relative turns, and touch state.
- Crossfader keyframes containing time and normalized effective position.
- The owner deck side and crossfader curve version.

Forward and reverse motion are represented by the slope between platter
keyframes. A touched flat span represents a hold and its duration. Redundant
points may be simplified only within a tested audible tolerance.

Device-specific jog calibration converts incoming units to the internal turn
timebase before recording. Device calibration is not stored in a pattern, so a
pattern replays identically without its original controller. The completed,
possibly simplified pattern becomes the source of truth; it is not required to
be sample-identical to the unsaved live gesture that produced it.

The notation shown in the editor is a view of this same data:

- Forward and reverse platter-motion segments.
- Hold spans.
- A crossfader automation lane.

Editing notation changes the action data directly and is undoable. Cropping
clips the event lanes, evaluates their values at the new boundaries, rebases
time to zero, and preserves the corresponding source offset.

### Persistence, replay, and sample output

Completed patterns are additive backend-authoritative project state held in the
`ValueTree` and written through the versioned project JSON path. Missing scratch
state in an older project means no pattern and does not change existing clip
behavior.

A timeline clip may reference a saved pattern non-destructively. Applying a
pattern to another clip starts from that clip's source window. A shorter source
uses the same boundary-silence rule rather than wrapping or stretching the
pattern.

Saved-pattern audition, timeline playback, mixdown, and rendering to a new
library sample use the same closed-form scratch trajectory evaluator and DSP.
Given the same prepared source and stored pattern, live and offline replay must
be independent of callback block size and seek history. Rendered samples are
written to disk through the existing sample pipeline and retain source and
pattern provenance.

Live gesture capture may differ slightly from its simplified stored pattern.
The user auditions the completed pattern before applying or saving it.

An in-progress recording is transient. Engine loss aborts it explicitly rather
than presenting an incomplete recording as successful. A committed pattern is
covered by normal project save, autosave, undo, and recovery behavior.

### Real-time and acceptance gates

The implementation must satisfy the existing audio-thread contract:

- No allocation, locking, logging, file access, bridge send, or wait in the
  audio callback.
- Input and edited pattern data reach the callback through bounded lock-free
  snapshots.
- Rendering work is bounded independently of MIDI event rate.
- UI animation and notation updates are throttled and cannot control audio
  timing.

The feature cannot leave the prototype phase until automated tests and a
reference hardware run demonstrate:

- Correct 1.8-second nominal revolution timing.
- Click-free holds, releases, reversals, linear crossfader transitions, and
  source boundaries.
- Stable output at the accepted maximum forward and reverse speeds.
- Equivalent live and offline replay of the same stored pattern.
- No callback overruns or regression of the configured audio budget.
- Deterministic crop, edit, persistence, undo, reload, and recovery behavior.

Controller Record mappings require verified byte-level messages. The editor's
Record button remains available when a supported profile has no verified
physical mapping.

## Prototype result

The initial isolated DSP prototype uses a 64-tap windowed-sinc interpolator,
continuous speed-dependent low-pass cutoff, 4 ms rate smoothing, 2 ms gain
smoothing, 3 ms source-boundary fades, and a candidate maximum rate of ±8×.

On the reference Windows x64 Release build, 4,000 stereo 512-sample blocks at
48 kHz measured 0.583 ms median, 0.735 ms p95, and 6.530 ms maximum against a
10.667 ms block budget, with no overruns. Automated coverage exercises nominal
33⅓ RPM timing, forward and reverse reads, holds, direction changes, gain
changes, source boundaries, invalid output ranges, and alias rejection at
±2×, ±4×, and ±8×.

This result is sufficient to begin protocol and session integration. The speed
cap remains subject to the later reference-controller and listening validation
required by this ADR.

## Why

Recording control actions preserves the user's performance without committing
it immediately to audio. It supports editing, replay, reuse, and deterministic
sample rendering while keeping the source file unchanged.

A dedicated session prevents a modal editor from moving the arrangement
playhead or bypassing the global dialog gate. Direct backend consumption of
semantic platter controls keeps the high-rate path short while retaining the
existing profile-driven MIDI architecture.

An internal platter timebase gives controller calibration and visual rotation
a shared meaning across different jog-wheel sizes. Selecting the DSP and speed
cap through measurement protects audio quality without promising an arbitrary
extreme rate.

## Consequences

- Scratch playback needs a dedicated bidirectional varispeed source rather than
  reusing short arrangement scrub grains.
- MIDI routing gains an explicit input owner for the active scratch session.
- Supported profiles may need measured jog-units-per-revolution metadata.
- Project state and the bridge gain a versioned scratch-pattern domain.
- Pattern playback becomes part of the canonical clip render chain.
- Sample export can render a performance without recording live audio into
  memory or sending audio over the text bridge.

## Rejected alternatives

- **Let modal MIDI fall through to existing global actions.** This would allow
  the arrangement to move behind the editor and contradict the dialog gate.
- **Seek the arrangement transport for scratch audition.** This couples draft
  work to the open project and makes isolated replay and rendering harder.
- **Record only the live audio output.** This produces a sample but loses the
  editable performance and cannot be reapplied non-destructively.
- **Send every MIDI movement through the renderer before audio processing.**
  The extra scheduling and bridge round trip add avoidable jitter to the
  highest-rate control path.
- **Use tempo-preserving warp for platter movement.** Vinyl-style varispeed must
  change pitch with speed and direction.
- **Allow unlimited jog speed.** Rates beyond the resampler and source-read
  budget create digital artefacts and unbounded callback work.
- **Wrap at source boundaries.** Hidden looping changes the recorded gesture
  and makes patterns depend unpredictably on source length.
- **Guess Record-button messages for every supported device.** Incorrect
  mappings are worse than leaving the physical shortcut unavailable.

## Amendment 1 — Backing accompaniment monitor (Phase 3)

- **Date:** 2026-07-13 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

### Context

The original decision scopes the editor to a single virtual deck auditioned in
isolation: `The opposite side contains silence`. In real practice a DJ scratches
*over* a second record that keeps playing. Without an accompaniment the user
cannot hear their scratch in musical context, so timing and phrasing are hard to
judge while recording. This amendment adds an optional, fixed-length backing
bed the user can scratch over while recording a pattern destined for a new
sample. It is explicitly not a mixing surface: it exists only to provide musical
context, and it keeps every existing real-time, non-destructive, and crossfader
guarantee intact.

### Decision

While the editor is open the user may select a set of timeline tracks to play as
a **backing accompaniment monitor** underneath the scratch deck.

- **The backing is a fixed-length scratch-over bed, not a mix.** Its sole
  purpose is to give the performer musical context to scratch against while
  recording a pattern for a new sample. It is never a mixing surface and never
  reaches committed output.
- **The user chooses a backing window before playback: a start anchor and a
  fixed duration.** The start anchor is either the **arrangement start**
  (project origin) or the **current playhead position**. The duration is a
  fixed choice — **30, 60, or 90 seconds** (default 30). The backing is the
  selected-track mixdown over `[anchor, anchor + duration)`.
- **The chosen window bounds the session, not the edited clip.** When a backing
  window is active, nominal playback and recording run the linear session clock
  from zero to the window duration and then stop; the window length, not the
  clip's span, is the forward time bound. The short scratch source is
  manipulated over that time and still follows the no-wrap boundary-silence
  rule within its own bounds. With no backing window, the session behaves as
  originally specified and is bounded by the scratch source.
- **Source is pre-rendered, not a live second engine.** The backing is a linear
  mixdown of the selected tracks over the chosen window, prepared off the audio
  thread and written to the existing disk/cache boundary exactly like the
  prepared scratch source. The scratch stage reads it as a plain linear buffer.
  A live second arrangement renderer inside the editor is rejected as too large
  and too costly for the audio callback.
- **The backing follows the linear session clock, never the scratch
  trajectory.** When the audition transport plays, the backing advances forward
  at nominal speed and stays phase-aligned to the session start. Platter
  varispeed, reverse, and holds move only the scratch deck; they never move the
  backing. Stop and skip-to-start reset both together. The editor still does not
  seek, start, or stop the arrangement transport — the backing is a separate
  prepared monitor source, not the arrangement.
- **The backing track set is the user's choice, made before playback.** The
  user selects any subset of timeline tracks — or all of them — to form the
  backing. To avoid hearing the scratched source twice, the track that owns the
  clip under edit is **excluded by default**, but the user may include or
  exclude any track, including the owning track. The selection is fixed before
  audition or recording starts for that pass.
- **The crossfader still controls only the scratch deck.** The backing is a
  fixed-gain accompaniment bus, not the crossfader's opposite side. This refines
  the original `The opposite side contains silence` statement: the audible
  opposite of the scratch deck may now be the backing monitor, but the
  `linear-v1` crossfader gain law is applied only to the scratch deck's gain and
  the backing is summed at a constant monitor level independent of the fader.
  Recorded crossfader keyframes are unchanged and still capture only the scratch
  deck's effective fader value.
- **The backing is monitor-only.** It is not captured into the recorded pattern,
  is not part of the canonical clip render, mixdown, or sample-export chain, and
  carries no provenance in the pattern. Patterns remain controller-independent
  and audio output remains non-destructive with no dry-signal doubling. Backing
  track selection is transient editor state, not persisted project state.
- **Preparation and invalidation.** Preparation runs off the audio thread. A
  fingerprint over the selected track set, their audible mixdown, and the span
  invalidates the prepared backing. A missing, stale, or failed backing degrades
  to silence; audition and recording still function without it.
- **Bridge and protocol.** The renderer sets the backing track selection and
  requests preparation through typed `SCRATCH_SESSION_CONTROL` fields; the
  backend prepares the buffer and reports display-only readiness in throttled
  `SCRATCH_SESSION_STATE`. Bulk backing audio travels through disk, never the
  text bridge, and the renderer never drives backing audio timing.
- **Real-time gates.** The backing is read as a bounded linear source and summed
  into the existing scratch output at a fixed monitor gain. No allocation,
  locking, logging, file access, bridge send, or wait occurs in the callback,
  and mixing cost is bounded independently of MIDI or UI event rate.

### Why

Hearing the scratch against its musical bed is essential to judging timing while
recording, and it matches the two-deck mental model the feature targets.
Pre-rendering the accompaniment keeps the high-rate audio path a single linear
read and honours the real-time and text-bridge contracts. Treating the backing
as a fixed monitor rather than the crossfader's other side preserves the
existing deterministic crossfader and replay model. Keeping it out of the
pattern and the render chain preserves non-destructive editing and avoids
doubling the dry source into exported audio.

### Consequences

- The scratch session gains transient backing state — track selection plus the
  chosen window (start anchor and fixed duration) — and a prepared backing
  buffer alongside the prepared scratch source.
- When a backing window is active it becomes the session's forward time bound,
  so nominal playback and recording stop at the window duration rather than at
  the scratch source's end.
- The bridge protocol gains backing track selection, window (anchor + duration),
  and backing-readiness fields; all remain display-only and non-authoritative
  for audio timing.
- The canonical clip render, mixdown, and sample-export chain are unchanged; the
  backing never contributes to committed output.

### Rejected alternatives

- **Run a second live arrangement renderer in the editor.** Too large, and it
  puts unbounded mixing and streaming work on the audio callback.
- **Route the backing through the crossfader's opposite side.** This would make
  the fader blend two decks and break the deterministic single-deck crossfader
  and replay model the original decision relies on.
- **Bake the backing into the recorded pattern or exported sample.** This loses
  the editable, controller-independent performance and doubles dry audio into
  non-destructive output.
- **Send backing audio over the text bridge.** Violates the text-only bridge;
  bulk audio belongs on the disk/cache boundary.

## Amendment 2 — Backing window durations and monitor trims

- **Date:** 2026-07-14 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

### Context

Two things changed as the backing monitor (Amendment 1) was used in practice.
First, a 30-second window proved too short to phrase a scratch against a musical
bed, and the three fixed lengths did not reach far enough for a longer take.
Second, a single fixed monitor level for the backing bed made it hard to balance
the scratch deck against the accompaniment while auditioning — the performer
could not make the bed quieter to hear the scratch, or lower a hot scratch source
under the bed. This amendment revises the fixed durations and adds two
**monitor-only** trims. It changes no real-time, non-destructive, persistence, or
crossfader guarantee.

### Decision

- **Backing window durations are now 60, 90, or 120 seconds (default 60),**
  superseding the *30, 60, or 90 seconds (default 30)* set in Amendment 1.
  Everything else about the window — the start anchor (arrangement start or
  current playhead), the window bounding the session's forward time, and the
  no-wrap boundary-silence rule — is unchanged. Persisted patterns carry no
  window, so this default change cannot affect any saved pattern.
- **Two monitor-only gain trims are added, each normalised `0..1` with a neutral
  default of `1.0` (100%):**
  - a **backing monitor gain** applied to the pre-rendered backing bed, and
  - a **scratch monitor gain** applied to the scratch deck's audition output
    *after* the `linear-v1` crossfader gain (the effective audition gain is
    `crossfaderSideGain × scratchMonitorGain`).
- **Both trims are audition-only and are never captured or baked.** They are not
  written into the recorded pattern, carry no provenance, and do not affect the
  canonical clip render, mixdown, or sample-export chain. They exist solely so
  the performer can balance what they *hear* while recording. This preserves the
  non-destructive and controller-independent guarantees: the same stored pattern
  and prepared source still replay identically offline regardless of the trims
  used while recording. The recorded crossfader keyframes remain the scratch
  deck's effective post-catch-up fader value only.
- **Bridge and state.** The trims are set through the existing
  `SCRATCH_SESSION_CONTROL` command (`backingGain` / `scratchGain` actions, each
  a `0..1` value) and echoed back display-only in `SCRATCH_SESSION_STATE`
  (`backingGain` / `scratchMonitorGain`). Both remain non-authoritative for audio
  timing, consistent with the rest of the session state.

### Why

Longer windows give room to phrase a take; adjustable monitor levels let the
performer judge the balance between the scratch and its bed while recording.
Keeping the trims out of the pattern and the render chain preserves the
deterministic, non-destructive replay model the original decision and Amendment 1
depend on — a monitor mix must never leak into committed output.

### Consequences

- The backing duration choice is 60/90/120 (default 60); UI, protocol validation,
  and the prepared-window fingerprint all use this set.
- The scratch session gains two transient monitor-gain values alongside the
  existing transient backing state; neither is persisted or rendered.

### Rejected alternatives

- **Record the monitor trims into the pattern.** This would make replay depend on
  the audition mix and could double or attenuate the source in exported audio,
  breaking non-destructive output.
- **Route the trims through the crossfader curve.** The crossfader stays a
  single deterministic `linear-v1` law on the scratch deck; a monitor balance is
  a separate concern and must not perturb recorded fader keyframes.

## Amendment 3 — Keyboard crossfader cut and library-item authoring

- **Date:** 2026-07-14 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

### Context

Two capabilities were added while integrating the editor. First, scratching by
hand needs a fast momentary "cut" without reaching for a mouse or a physical
mixer, so a keyboard-driven crossfader cut was added. Second, the original
decision framed the editor around a selected **timeline clip**; in use, authoring
a scratch directly from a **library item** (including a previously saved scratch
clip) is just as useful, so the open path was widened.

### Decision

- **A momentary keyboard crossfader cut is available inside the editor.** Holding
  a single configurable key closes the crossfader (scratch deck silent);
  releasing it reopens it. The resting state is open, so nothing is sent until the
  key is first pressed, and blur/close force the fader open so a held key can
  never leave the deck stuck silent. The key is chosen in **Preferences ▸
  Effects ▸ Scratch crossfader cut** — **Z** (right-handed, default) or **M**
  (left-handed). (Shift was rejected because holding it triggers Windows Sticky
  Keys.) The cut writes the same `0..1` crossfader value as any other fader input,
  so while recording it is captured into the pattern exactly like a pointer or
  MIDI fader move — it is an *input method*, not a new recorded field.
- **The editor opens from a timeline clip or from a library item.** A single
  reused editor dialog is opened either from a timeline clip's context menu or
  from a library item's context menu (including a saved scratch **clip** item).
  When opened from a saved clip, the waveform and prepared window resolve through
  the clip's source library item and its `derivedFrom` window, so a saved clip
  scratches over its own cropped region rather than the head of the source.

### Why

A one-hand keyboard cut matches how a DJ chops the fader while the other hand
works the platter, and choosing the side suits handedness. Widening the open path
lets a user author or re-author a scratch straight from the library without first
placing the source on the timeline, while the single shared dialog instance keeps
exactly one live scratch session.

### Consequences

- Scratch input preferences gain one persisted field, `crossfaderCutKey`
  (`KeyZ` default / `KeyM`); an unrecognised persisted value falls back to the
  default, so older or corrupt prefs always open.
- The open contract accepts either a `clipId` or a `libraryItemId` (exactly one);
  saved-clip targets resolve their source window for preparation and waveform
  display.

## Amendment 4 — Transport drives the backing channel only

- **Date:** 2026-07-15 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

### Context

The original decision (and Amendment 1) gave the editor's local **Play** control
two jobs at once: it ran the scratch platter at its nominal speed *and* started
the backing bed. In use this conflated two different intents — auditioning the
clip versus running the accompaniment the scratch is performed against — and made
"play" audition a flat, un-scratched clip, which is not how the deck is meant to
be heard. The backing panel was also buried below the waveform, away from the
controls that now drive it.

### Decision

- **The on-screen transport (skip-to-start, play/pause, skip-to-end) and its
  `Space` shortcut drive the backing channel only.** Play starts/stops the
  prepared backing bed; skip seeks the backing bed; they no longer set the scratch
  source playing. The scratch clip is heard **only when the platter is jogged**
  (the touched/manual-rate path), so "play" never auditions the clip at nominal
  speed. `backingDurationUs` bounds skip-to-end.
- **The transport is disabled until a backing is prepared, and during
  recording.** With no backing there is nothing for the transport to run, so the
  backend rejects `play`/`seek` control actions when no backing is ready and the
  UI disables the controls. Recording still owns playback (it spins the scratch
  over the backing), so the transport is inert while a take is in progress.
- **The backing panel moves to the top of the dialog and hosts the transport.**
  The play/skip cluster lives in the backing-panel header next to the *Backing
  deck* label and status. The former position / length / rate / touch readout is
  removed.
- **The physical MIDI deck's transport button is unchanged.** The hardware deck
  play button remains a separate control surface and still spins the scratch
  source (used when auditioning through a connected controller); only the
  on-screen/keyboard transport is re-scoped to the backing.

### Why

Separating the two intents matches how the tool is used: the accompaniment runs
as a bed while the performer scratches over it by hand. Auditioning a flat clip
through "play" added no value once jogging exists, and gating the transport on a
prepared backing removes a control that previously did nothing useful without
one. Keeping the MIDI deck button as-is avoids changing a physical-controller
contract that a follow-up change can revisit deliberately.

### Consequences

- The scratch source's nominal-speed playback is now reached only through
  **recording** (which spins the clip under the backing) and the unchanged MIDI
  deck button — never the on-screen transport. Backend tests that previously drove
  the scratch source via `play` now prepare a backing and assert the
  backing-window state machine, and the audio/crossfader-gain tests spin the
  source's motor directly (its recording-time state).
- No new bridge field is required: skip-to-end reuses `backingDurationUs`, and the
  removed readout drops the per-frame position/rate display from the transport.
- The backing window continues to bound the session (Amendment 1); the scratch
  source's own forward-end now matters only while recording without a backing.

## Amendment 5 — Backing length options and scratch monitor default

- **Date:** 2026-07-16 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

### Context

Amendment 2 fixed the backing window at **60, 90, or 120 seconds**. In practice
90 s was rarely chosen, while performers wanted to scratch over a *whole
arrangement* rather than a capped window. Separately, the scratch monitor gain
defaulted to 100%, which put the raw source at the same level as the backing bed
and made it hard to hear the clip *against* the accompaniment while auditioning.

### Decision

- **Backing length options are now `60`, `120`, and `Full`** (default `60`). The
  90 s window is retired. **`Full`** spans from the anchor to the **last clip end**
  of the selected tracks (the arrangement's content extent), computed on the
  message thread when preparing. On the bridge, `Full` is the sentinel
  `durationSec: 0`; the accepted set is `{0, 60, 120}` and `90` now rejects.
- **The scratch monitor gain now defaults to `0.75` (75%)** so the source sits
  under the backing while auditioning. The Monitor (backing) gain default is
  unchanged at 100%. Both remain **monitor-only, per-session, non-persisted**
  trims that are never baked into the recorded pattern, mixdown, or export.

### Why

`Full` matches the real intent — scratching over the whole piece — without a
per-arrangement length guess, and dropping the unused 90 s keeps the control
compact. Defaulting the scratch monitor to 75% gives an immediately usable
balance instead of two coincident full-level sources. Both are session-scoped
monitor trims, so there is no persisted-preference or backward-compatibility
concern.

### Consequences

- The bridge duration union becomes `60 | 120 | 0`; backend validation accepts
  `{0, 60, 120}` and `handleScratchBackingPrepare` derives the `Full` window from
  `computeLastClipEndMs(snapshot) - anchorMs` (clamped ≥ 0; an empty selection or
  a past-end anchor yields a zero window and the usual preparation error).
- An empty backing selection with `Full` still produces no window, surfacing the
  existing "duration is zero" preparation error rather than a special case.
- Protocol tests assert `0`/`60`/`120` parse and `90` rejects; the default
  scratch monitor gain change is covered by the existing per-session gain state.

## Amendment 6 — Backing config locks while playing; Clear removed

- **Date:** 2026-07-16 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

### Context

The backing bed is a fixed pre-render (Amendment 1). While it was playing, the
track selection, anchor, and length controls stayed enabled, which implied a
track could be *switched in* live — but a change only takes effect after a fresh
**Prepare**, so the edit was silently ineffective until re-prepared. The panel
also carried a separate **Clear** button whose only role was to drop a prepared
bed.

### Decision

- **The preparation config is locked while the backing is playing.** The track
  toggles, start-anchor buttons, length buttons, and the **Prepare** button are
  disabled whenever the backing transport is playing. They re-enable once
  playback stops, at which point a changed config can be re-prepared.
- **The Clear button is removed.** Re-preparing replaces the existing bed, so a
  distinct clear action is redundant. The `SCRATCH_BACKING_CLEAR` bridge message
  and composable method remain part of the protocol/API for session teardown;
  only the UI affordance is gone.

### Why

Locking the config while playing removes the false affordance that tracks can be
swapped into a running bed, matching the pre-render contract. Dropping Clear
keeps the panel to a single, unambiguous action (Prepare/replace) now that the
transport, not this panel, owns playback (Amendment 4).

### Consequences

- Reconfiguring the bed requires pausing first; the monitor-only gain trims stay
  live while playing (they are not part of the pre-render).
- No way remains to return a session to *no backing* from the UI; this is
  acceptable because the session itself is transient and re-preparing covers the
  swap case. The bridge clear path is retained for programmatic teardown.

## Amendment 7 — Crossfader bar colour follows position and direction

- **Date:** 2026-07-16 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

### Context

The on-screen crossfader accented a fixed left→knob fill, so it always read the
same way regardless of the per-device MIDI **crossfader direction** preference
(`leftToRight` / `rightToLeft`). It also briefly tied the colour to the active
deck, which made the bar change when the platter was touched — an unwanted side
effect, since touching a platter must never alter the fader's appearance.

### Decision

- **The bar colour is a function of fader position and direction only.** The
  snapshot carries a display-only `crossfaderReversed` boolean that mirrors the
  session's MIDI crossfader direction (`true` = `rightToLeft`). Deck ownership
  never affects it.
  - **`leftToRight`:** blue fills from the left as the knob moves right — blue at
    the fully-right extreme, black at the fully-left extreme.
  - **`rightToLeft`:** mirrored — blue fills from the right as the knob moves
    left, so blue at the fully-left extreme, black at the fully-right extreme.
  - The `L`/`R` label on the blue extreme is accented.
- **Recolour only — the knob never moves.** Changing direction never rewrites
  `crossfaderDisplay`; only the colouring follows the preference.

### Why

Matching a physical crossfader's LED bar (position × wiring direction) keeps the
on-screen fader a faithful mirror of the controller. Deriving the colour purely
from position and direction — never from deck ownership or platter touch —
guarantees the appearance is stable while performing.

### Consequences

- Touching a platter, claiming a deck, or recording never changes the bar colour
  or the knob position.
- Older payloads without `crossfaderReversed` default to `leftToRight`, preserving
  the prior appearance.

## Amendment 8 — Keyboard crossfader cut is push-to-open from a closed default

- **Date:** 2026-07-14 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

### Context

Amendment 3 defined the keyboard crossfader cut as resting **open** with the key
**closing** the fader while held. In practice, with keyboard and trackpad, this
read backwards: pressing a key to *silence* the deck felt inverted, and the
button state was out of sync with the fader — the default was open, yet a press
is naturally understood as swinging the fader *in*.

### Decision

- **The keyboard cut is push-to-open from a closed resting default.** Holding the
  configured key now **opens** the crossfader (scratch deck audible); releasing it
  **closes** it again. The resting default is **closed**, and it is asserted once
  the session becomes controllable so the visible fader and the audio agree before
  any key is pressed. Blur/close force the fader back **closed** so a held key can
  never leave the deck stuck open. The key choice (**Z** / **M**) is unchanged.
- **MIDI crossfader controls are untouched.** This narrows only the
  keyboard/trackpad path; the MIDI fader's direction, gain, and value handling
  keep their existing behaviour.

### Why

A press that opens the fader matches the physical intuition of moving the fader
in, and a closed default means silence until the performer deliberately cuts the
deck in — the reverse of Amendment 3, which read backwards in hand testing. The
cut still writes the same `0..1` crossfader value, so it remains an input method
captured into a recording like any other fader move.

### Consequences

- Amendment 3's "resting state is open … blur/close force the fader open" is
  superseded: the resting state is now closed and safety settles the fader closed.
- The editor emits one crossfader `value` when the session becomes controllable to
  establish the closed default; this affects the pointer fader's starting position
  too, but never the MIDI control paths.

## Amendment 9 — Scratch fader bar colour depends on the control source

- **Date:** 2026-07-14 · **Status:** Accepted · **Owner:** @irarainey ·
  **Importance:** `IMPORTANT`

### Context

Amendment 7 coloured the on-screen crossfader bar by position × the per-device
MIDI crossfader **direction** preference (`crossfaderReversed`). Combined with the
Amendment 8 keyboard cut — which writes a fixed value (deck-1 audible at 0),
independent of that preference — the bar read **backwards** under `leftToRight`
when driven from the keyboard: releasing the key (fader closed, deck silent) lit
the bar blue, while pressing it (fader open) went black. The direction preference
belongs to physical MIDI crossfaders; it has no bearing on keyboard/trackpad
operation, yet a MIDI-owned session must still mirror its controller's wiring.

### Decision

- **The bar colouring depends on the control source.** A session is
  MIDI-controlled when a physical device owns it (`ownerDeviceIdentifier` is set);
  otherwise it is keyboard/pointer operated.
  - **MIDI-owned:** unchanged from Amendment 7 — the bar mirrors the device's
    crossfader direction preference (`crossfaderReversed`).
  - **Keyboard/pointer:** the direction preference is ignored; the bar colours by
    **open/closed**. The scratch deck is audible at value 0, so blue stays on the
    open (value → 0) edge and the bar is black when closed (value → 1). This is the
    same fill geometry as a reversed bar, so the shared `ScratchCrossfader`
    `reversed` prop expresses both modes; the parent computes its value per source.
- **Recolour only — the knob never moves,** regardless of source.

### Why

The scratch editor is primarily a keyboard/trackpad tool, so under those inputs the
fader must read the same way every time: open looks open, closed looks closed,
independent of a hardware-wiring preference the keyboard ignores. A MIDI-owned
session still needs to mirror its physical crossfader, so the decision keys off
ownership rather than dropping the direction behaviour outright.

### Consequences

- Amendment 7's direction-driven colouring now applies **only** while a MIDI
  device owns the session; keyboard/pointer operation colours by open/closed.
- The backend still publishes `crossfaderReversed`; the frontend derives the
  effective bar `reversed` flag from ownership plus that preference.
