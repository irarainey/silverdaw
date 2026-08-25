# ADR 0025 — VST3 effect-plugin hosting as per-track inserts

- **Date:** 2026-08-24 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Context

Silverdaw's effects are a fixed, hand-built set: `TrackChain` sequences Tone,
Leveler, Saturation, Bit Crusher, and Punch per track, and the project bus adds
shared Reverb and Delay, Glue Compressor, and Safety Limiter. That set is
deliberately small and beginner-first, but it caps what a user can do to their
own material.

Hosting third-party VST3 effects lifts that cap. It also imports code we do not
own into the audio callback, into the engine process, and into saved projects —
which touches the real-time constraint (ADR 0006), engine resilience (ADR 0008),
the canonical routing (ADR 0022), and the backward-compatibility guarantee for
a released product (ADR 0019). Those interactions are the decision.

## Decision

Silverdaw hosts **VST3 effect plugins only**, as **per-track inserts**.

### Routing

Plugin inserts extend the canonical path in ADR 0022. Per track:

```text
Tone / Filter -> Compressor -> Saturation -> Bit Crusher -> Punch
  -> plugin inserts, in user order
  -> post-FX track level and effective mute / solo gain
  -> pre-pan Reverb and Delay sends -> equal-power pan -> dry project bus
```

Inserts sit at the end of tonal shaping and upstream of level, sends, and pan,
so a plugin cannot change what mute, solo, or the send amounts mean. Offline
mixdown runs the same inserts in the same position; a plugin that changes the
render but not playback is a bug, not a tolerated difference.

### Real-time safety

Our code on the audio thread stays bound by ADR 0006 in full. Third-party
`processBlock` is a **bounded, documented exception**: a plugin may allocate or
lock inside its own call and we cannot prevent it.

The exception is bounded by keeping every operation we control off the callback.
Scanning, instantiation, `prepareToPlay`, state restore, and destruction happen
on the message thread. A prepared chain reaches the audio thread only as an
immutable snapshot published by an atomic pointer swap, with the previous
snapshot retired on the message thread — the mechanism ADR 0006 already
prescribes and `TrackAutomationSnapshot` already uses. Bypass is a ramped gain
rather than a graph edit, and an inaudible track skips its inserts under ADR
0020 after flushing silence so tails decay instead of being cut.

Hosted plugins are given a shared read-only play head so tempo-synced effects
follow the transport. It reads the engine's own position, sample-rate and
play-state atomics rather than copies of them, so a plugin cannot drift from
what the renderer is doing, and the offline render points an equivalent play
head at the mixdown position for export parity.

Plugin latency is **reported but not compensated** in v1: `PluginChain` sums
`getLatencySamples()` and exposes it, but nothing delays the other tracks to
match. Per-track delay compensation touches every timing-sensitive path in the
engine — clip scheduling, automation sampling, metering and the mixdown's
sample-accurate parity guarantee — and is a change large enough to deserve its
own decision. Until then, a latent plugin shifts its track late relative to the
rest of the mix; the limitation is documented for the user rather than hidden.

### Process model

Plugins are **scanned out-of-process** and **hosted in-process**.

Scanning loads unknown binaries and is where a bad plugin most often takes the
host down, so it runs in a child process behind a persistent blacklist: a
plugin that crashes the scanner is recorded and not retried. Hosting runs
inside the engine process, and a crash there is a normal recoverable event
under ADR 0008 — the supervisor respawns the backend and the recovery
coordinator reloads the project.

### Plugin editors

A VST3 editor is a native window and cannot be embedded in an Electron
`BrowserWindow`. The **backend owns the editor window**. When a plugin has no
usable editor of its own, that window falls back to a generic parameter list
built from the plugin's own parameters, so every plugin stays controllable.

### Persistence

A plugin slot persists additively on its track: identifier, format, display
name, file path, bypass, and the plugin's state chunk as base64 **inline in the
project file**, so a project remains a single self-contained file.

State chunks never travel over the bridge. The bridge carries small descriptors
only, and the engine reads and writes chunk bytes itself — ADR 0003 unchanged.

A saved chunk is only refreshed on save, so it is not a live mirror of what the
user is doing in a plugin's editor. Rebuilding a chain from the project tree —
which undo does for *every* track, including for edits with nothing to do with
plugins — therefore **keeps the instances it already has** whenever the slot id
and plugin identifier still match, and re-creates only what actually changed.
Destroying and reloading unconditionally would reset a plugin to its last-saved
settings as a side effect of an unrelated undo, and close its editor with it.

A plugin that is missing on the machine opening the project becomes an
**unresolved slot**: it keeps its position and its saved state, passes audio
through untouched, is drawn greyed, and is written back out on save. Under
ADR 0019 a missing plugin may never silently drop a user's settings.

### Scope

v1 hosts effect plugins only. Instrument plugins, per-clip inserts, sidechain
inputs, MIDI to and from plugins, plugin-parameter automation, and the VST2,
CLAP, and AU formats are out of scope. Plugin-parameter automation in
particular needs a dynamic replacement for the fixed `AutomationParam` enum and
is a decision of its own.

## Why

- Placing inserts before level, sends, and pan keeps every existing mix control
  meaning what it meant before a plugin was added.
- One routing shared by playback and mixdown is the whole point of ADR 0022;
  giving plugins a second path would reintroduce exactly the export drift that
  ADR forbids.
- Sandboxing the scan buys most of the available crash protection for a small
  fraction of the cost of sandboxing the audio path, and the engine already has
  a supervisor, a watchdog, and project reload for the residual risk.
- Naming the real-time exception explicitly is safer than leaving it implied.
  An unstated exception erodes into "the rule is negotiable"; a stated one
  keeps the rule intact for our code and confines the compromise to code we
  cannot change.
- An unresolved slot means a user can open a project on a second machine,
  install the plugin later, and get their settings back. Dropping the slot on
  load would destroy work silently, which ADR 0019 does not permit.
- A generic parameter list is the beginner-first surface (ADR 0011): the same
  controls appear for every plugin whether or not its own editor is usable.

## Rejected alternatives

- **Host plugins out-of-process with shared-memory audio IPC.** A true sandbox,
  but it needs a real-time-safe cross-process ring buffer and its own failure,
  latency, and lifecycle model — a large subsystem whose risk exceeds the
  crash risk it removes, given the engine is already recoverable. Revisit if
  real-world crash data justifies it.
- **Skip out-of-process scanning too.** Scanning executes arbitrary unvetted
  binaries at startup; a single bad plugin would make the app unlaunchable with
  no way for a user to recover.
- **Place inserts after the track level and sends, or on the project bus only.**
  Post-level inserts let a plugin's output gain fight the fader and change what
  a send amount means. A project-bus-only design cannot treat one track
  differently, which is the main reason to want plugins at all.
- **Store state chunks in sidecar files beside the project.** Keeps project
  JSON small, but a project stops being one movable, copyable file and a lost
  sidecar silently resets every plugin.
- **Send state chunks over the bridge.** Chunks reach megabytes and would stall
  the single-threaded IXWebSocket loop — precisely what ADR 0003 exists to
  prevent.
- **Drop unknown plugins on load.** Simple, and quietly destroys settings the
  user cannot recover.
- **Embed the plugin editor in the renderer.** A native VST3 editor is an
  OS-level window; reparenting one into a sandboxed Electron renderer is not
  supportable.
- **Support VST2 as well.** Its SDK is no longer licensable for new hosts.
