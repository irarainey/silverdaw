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
