# ADR 0030 — Audio recording: a standalone capture device, a recording bounded by a time window, and an on-grid library item

- **Date:** 2026-09-04 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Context

Plan §11.6 (issue #35) calls for a simple way to record live input — vocals, an
instrument, a line input, found sound — without Silverdaw becoming a multitrack
recording studio. This ADR records the design agreed **before** implementation,
so that the constraints it turns on are settled once rather than rediscovered
per pull request. Where it describes behaviour that does not exist yet it is
prescriptive, not descriptive.

Three facts in the current codebase shape the whole design.

**Everything downstream of import assumes a finished file.** A `CLIP` references
a `libraryItemId`, which references audio on disk; peaks are computed from that
file and cached; warp, envelopes, brake and backspin all read it non-destructively
(ADR 0007). There is no concept anywhere of a clip whose audio is still being
produced.

**The engine is deliberately opened output-only.**
`AudioEngine::openDefaultOutputOnly()` says why:

```cpp
// Request the default output with NO input endpoint: an empty input device plus
// useDefaultInputChannels=false stops JUCE opening the default capture client,
// which is the tens-of-seconds stall on a problematic default mic.
```

`selectAudioDevice(...)` repeats the clearing, and `rebuildDevicesSnapshot(...)`
enumerates with `getDeviceNames(/*wantInputNames*/ false)`. No audio-input
concept exists in the backend, the bridge, `preferences.json` or the project
file; the only "input" today is MIDI. Recording therefore starts from zero on
the device layer, and must not undo the startup behaviour that comment protects.

**The Scratch Editor is a weaker precedent than it looks.**
`ScratchActionRecorder` captures platter, touch and crossfader *keyframes*, not
audio, and its backing "monitor" is an offline render into an in-memory buffer
(`prepareBackingToBuffer(...)`) because the platter cannot use the arrangement
transport (ADR 0021). What genuinely transfers is the session envelope shape
(`*_SESSION_OPEN` / `_CONTROL` / `_STATE` / `_CLOSE`), the save tail in
`ScratchSaveCommands.cpp` (WAV write → peaks on `peakPool` → `addLibraryItem` on
the message thread → `PROJECT_STATE`), and the artifact-folder conventions
(`projectArtifactsBaseDir(...)`, `migrateTempArtifactsIntoProject(...)`). The
audio capture itself is new.

## Decision

### Recording produces a library item; it never writes to a track

Recording is a transactional flow in one modal — **Record Audio** — that ends by
producing an ordinary library item. No track is record-armed, no clip grows on
the timeline, and no new "live clip" state is introduced into `ProjectState`.
The two exits are **Add to Library** and **Add to Timeline**; the latter is the
former plus an ordinary clip placement, bracketed in a single undo group. With
no track owning the recording, the timeline exit resolves a destination at
commit time: the selected track when it holds no clips at all, otherwise a new
track appended for it, scrolled into view either way. A recording is never
stacked on top of clips that are already arranged.

### A recording is bounded by a window in time, not by a track

The recording owns a start anchor and, optionally, an end. Two modes, and no
more:

- **From playhead** — starts at the playhead after any count-in, runs until
  Stop.
- **Over the selected range** — the existing timeline range selection *is* the
  record window, with auto-stop at its end.

The range is already a shared concept: the renderer holds it as
`uiStore.timelineSelection` (`{ startMs, endMs }`) and the engine owns it as
`AudioEngine::LoopRange` through `setTimelineLoop(...)`. Auto-stop is the same
boundary decision `playbackBoundary.ts` already makes for one-shot range
playback. Because a range drawn against the snap grid is grid-aligned by
construction, this mode is also what makes a recording's beat count true rather
than asserted (see below).

The anchor is retained on the finished recording, so the clip can be placed
exactly where it was played.

### The play-along is the arrangement transport

Recording rolls the real transport rather than preparing a separate bed. Mute
and solo already express "play along with only these tracks", and an optional
count-in (one bar, or none) reuses the existing metronome. Nothing
equivalent to `SCRATCH_BACKING_PREPARE` is built.

### Capture runs on a standalone input device, outside the engine's device manager

Input and output are assumed to be **different devices** — the common case is
monitoring through an interface or headphones while capturing from a USB
microphone. Capture therefore owns an input-only `juce::AudioIODevice`, created
from its own `AudioIODeviceType` and held by the recording subsystem. It is
**never** attached to the engine's `AudioDeviceManager` setup.

Consequences of that ownership split, all deliberate:

- Playback is never reconfigured, restarted or glitched by opening or closing
  the capture device; on ASIO, where one driver owns both directions, a combined
  device could not have expressed the split case at all.
- The input may come from a different driver type than the output.
- The capture device is opened **lazily** when the record surface opens and
  released when it closes, so the startup stall the output-only comment protects
  against cannot return.
- The recording captures **one selected source**, not every channel the device
  exposes: mono, or a stereo pair, taken from the device's first channels.
  Devices routinely present far more inputs than a performer means to record —
  the machine this was measured on offers an 8-channel microphone array — so
  opening the device's full channel set and writing it verbatim would produce a
  file nobody asked for. The surface offers the *shape* of the recording rather
  than a channel list, because "Channel 5" means nothing to someone holding a
  microphone; the backend keeps a general first-channel/count selection, so an
  interface-specific picker can be added later without a protocol change.
- **Input gain** is applied in the capture callback, into a pre-sized scratch
  buffer, so the written file and the meter always show the same signal. It is
  the only setting changeable while rolling: a performer who is clipping should
  not have to lose the take to fix it.
- The **driver** the input comes from is a machine-wide setup decision and lives
  in Preferences ▸ Audio beside the output driver, not on the record surface.
  Choosing a microphone must not mean choosing a backend first.
- Opening a capture device makes JUCE re-enumerate devices, and its device
  manager reverts to the system default whenever it decides the open output
  endpoint went away. That is how the split shows up in practice: the backing
  played to headphones while the finished take came out of the laptop speakers.
  The engine therefore remembers the output it last opened and restores it once
  per device-list change, rather than the recording subsystem touching playback.
- The capture callback is a **second real-time thread**, on a device the engine
  does not own. It obeys ADR 0006 in full and may not touch engine state: it
  writes into a preallocated lock-free ring, publishes an input peak as
  `std::atomic<float>` in the same shape as `MeteringSource`, and reads the
  published transport position atomically. Allocation, file I/O and every
  `ProjectState` mutation happen on the writer thread or the message thread.

### Latency and clock drift are corrected offline, at finalise

Two independent devices mean two nominal-but-unequal clocks, and a monitored
performance is captured late.

- **Latency:** the finished recording is offset by the capture device's
  `getInputLatencyInSamples()` plus the playback device's
  `getOutputLatencyInSamples()` — the performer heard the arrangement late and
  Silverdaw received their playing late.
- **Drift:** the true capture rate is derived by stamping the first and last
  captured block against `juce::Time::getHighResolutionTicks()` and the playback
  transport position, and the finished file is resampled by that ratio
  (`juce::LagrangeInterpolator`, as `OnnxStemSeparator.cpp` already uses).

Both corrections are applied **once, offline, off the audio thread**, before the
file becomes a library item. This is the file-first answer: a recording that
stays in time for its whole length rather than one that starts right and ends
late. Real-time drift compensation is explicitly not attempted.

### Every recording is musical

Because the recording is anchored on the timeline and the project tempo is
known, its tempo is a known value, not a detected one. The library item is
written with the **project BPM**, a `beatAnchorSec` derived from the anchor's
phase, and `audioType = "music"`, so a later project-tempo change warps it like
any other music clip. **No BPM detection is run on a recording.**

`musicalBeats` outranks everything else under ADR 0024, so it is written only
when it is true by construction — a recording bounded by a grid-aligned record
window. Because the capture always runs past the window end by however long the
auto-stop takes to reach the message thread, finalise also trims the tail back
to the exact musical length; without that the beat count divided by the file's
real duration resolves to a tempo that is not the project's, and the clip's beat
markers and warping are wrong even though the item stores the right BPM. A
recording too short to trim, or stopped by hand mid-beat, carries the tempo but
claims no bar count it never played.

### The count-in only borrows the metronome

A count-in forces the click on for the preroll and hands the metronome straight
back at the anchor, so what the performer hears through the take itself is the
project's own metronome setting. The dialog exposes that setting rather than
owning a second one, and the click is monitoring only: it is mixed post-master
into the output, never into the capture.

### Storage, provenance and naming

- Recordings are written as 24-bit WAV into a new `recordings/` artifact
  category, following the existing unsaved-project behaviour: the temp workspace
  first, relocated by `migrateTempArtifactsIntoProject(...)` on save.
- The library item is `kind = "sample"` with an additive `recordingOrigin`
  marker, mirroring how a baked scratch is a `sample` carrying `scratchOrigin`.
  **No new library kind is introduced.**
- Registering the category means four places: the `kCategories` list in
  `ProjectSession.cpp`, the folder→kind map in `ProjectStateLibrary.cpp`, and
  the cross-project import scan (`ProjectImportSource.cpp`,
  `ProjectImportCommands.cpp`) so that "import assets from another project" sees
  recordings. Portable relative-path rewriting is already generic.
- Items are named `Recording 1`, `Recording 2`, … — the next free number in the
  project, matching the WAV filename. Renaming already exists at library and
  clip level, so the default only has to be unsurprising and unique.
- New preference `audioInput: { typeName, deviceName } | null`, defaulting to
  null and deliberately separate from `audioOutput`. Every persisted addition
  here is additive with a safe default, so no project schema bump is required
  (ADR 0019).

### Bridge, monitoring and terminology

- New envelopes live in `shared/bridge/recording.ts` and are added to the zod
  schema first (ADR 0004). The finished file is announced with a `*_READY`
  envelope naming a path, never carried over the socket (ADR 0003).
- **There is no software monitoring in the first release**; input metering is
  always live. Round-trip monitoring is 20–40 ms on WASAPI shared mode and worse
  across two devices, so the honest answer is to point the user at headphones or
  their interface's own direct monitoring, and the wire contract carries no
  monitoring control at all rather than a toggle nothing can honour.
- The user-visible artefact is a **recording**, and that word is used
  everywhere — menu (**Record Audio…**), dialog (**Record Audio**), item
  (`Recording 1`), folder (`recordings/`) and code
  (`RecordingSessionController`, `RecordingWriter`). "Take" is not introduced as
  a second word for the same thing.
- Entry is a transport record button. `R` is claimed **inside the dialog only**,
  exactly as the Scratch Editor claims it inside its own, so there is no new
  global shortcut and the two can never collide.

## Consequences

**Packaging and consent change.** The MSIX package currently declares only
`runFullTrust` (`frontend/electron-builder.yml`), and `sessionSecurity.ts`
deliberately denies every renderer permission including microphone. Capture
happens in the backend Win32 process, so the renderer handler is not the
obstacle and should stay deny-all — but a packaged app with package identity is
subject to Windows microphone privacy consent, and the `microphone` device
capability will have to be declared for the Store build. The failure mode when
consent is absent is a device that opens and yields **silence**, which looks
exactly like a broken feature, so it must be detected and reported plainly.
Confirming the precise packaged behaviour is part of the spike below.

**The device spike has been run, and it supports this decision.** A dev tool,
`backend/tools/capture_probe/CaptureProbe.cpp` (built as `SilverdawCaptureProbe`
under `SILVERDAW_BUILD_TESTS`), opens playback exactly as
`openDefaultOutputOnly()` does, then creates, starts, runs and closes a
standalone input-only device beside it while counting callbacks, inter-callback
gaps, device restarts, sample totals and input peak. On a Windows Audio shared
mode pair (Realtek output, Intel Smart Sound microphone array input, both
48 kHz, 480-sample buffers) over a 60-second run:

- **Playback was never disturbed.** Callback counts before, during and after
  capture were identical to the expected block rate, the largest inter-callback
  gap stayed at jitter level throughout (≈11.8 ms against a 10 ms nominal
  period, unchanged across all three windows), and the device reported **zero**
  restarts or stops. Opening and closing a standalone capture device beside the
  running engine is genuinely free.
- **Round-trip latency was 20.0 ms** — 480 samples input plus 480 samples
  output, both self-reported by the devices, consistent with WASAPI shared mode
  and within the range that made monitoring off-by-default the right call.
- **Relative clock drift was 4.5 ppm, or 0.27 ms per minute.** Small, but not
  zero, and the two endpoints here likely share a mainboard clock; a USB
  interface against onboard output should be expected to be worse. Offline
  correction stays justified, and the correction ratio must be *measured* per
  recording rather than assumed.
- **Device enumeration did not stall.** Scanning inputs across all four driver
  types returned immediately, so the output-only comment's tens-of-seconds
  hazard is about *opening* a problematic default capture client, not about
  listing devices — enumerating for the record surface is safe.

Two failure modes remain unmeasured and stay as spike work: behaviour when the
capture device is removed mid-recording, and the packaged-MSIX consent path,
where the expected signature is a device that opens cleanly and returns digital
silence. The probe already detects and reports both (`audioDeviceStopped`
mid-run, and a zero peak over the whole capture), so the tool is the vehicle for
closing them.

**Recording is not free at runtime.** A capture ring, a writer thread and a
growing WAV run alongside normal playback. The writer enforces a hard length cap
and a free-space check, and aborts atomically rather than leaving a partial file
presented as a recording.

**What this design does not give the user.** No live waveform growing on the
timeline while recording; no punch-in over a longer pass; no looped recording
with stacked repeat passes; no comping; no multi-input capture; no input
effects. These are conventional multitrack workflows that would each drag record
arming and take management in behind them, and they are out of scope for the
first release rather than rejected forever.

## Rejected alternatives

- **Record straight onto a track, with a clip growing live on the timeline.**
  The conventional DAW model, and the one users arriving from other tools
  expect. Rejected because a `CLIP` is a reference into a finished file: a
  growing clip needs a second, transient clip concept that the peaks pipeline,
  warp, envelopes and the `ValueTree` source of truth (ADR 0002) all have no
  representation for. It would be the largest structural change in the app for a
  feature the plan explicitly wants kept minimal.
- **Reuse the Scratch Editor's backing preparation for the play-along.**
  Superficially the closest precedent, but it exists only because the platter
  cannot use the transport. Recording can, so a pre-rendered 60/120 s bed would
  add a preparation step, a track-selection surface and a second definition of
  "the mix" for no benefit.
- **Require input and output on one device, or attach the capture endpoint to
  the engine's `AudioDeviceManager`.** Simpler on paper and sample-locked, so no
  drift correction would be needed. Rejected because it is the wrong assumption
  about how the audience is set up, because changing that setup restarts the
  output device mid-session, and because ASIO cannot express a combined device
  across two drivers at all.
- **Compensate drift in real time** with an adaptive resampler on the capture
  path. Adds a continuously-adjusting resampler to a real-time thread and a
  control loop to tune, to solve a problem that can be measured exactly and
  fixed once when the file is finalised.
- **Give recordings their own library `kind`.** Rejected because `kind` is
  branched on across the renderer, the backend and the legacy-kind migration; a
  new value costs compatibility work in every one of them and buys nothing that
  an additive `recordingOrigin` marker does not.
- **Write recordings into `samples/`.** Would avoid registering a new artifact
  category in four places, but loses the on-disk distinction between something a
  user performed and something the app cut from existing audio — which matters
  when a project folder is inspected, synced or imported from.
- **Detect the BPM of a recording, or treat it as a one-shot.** Detection would
  guess at a value already known exactly, and would sometimes contradict it. A
  one-shot (`audioType = "simple"`) cannot hold a tempo at all under ADR 0024,
  so a recording made against the arrangement would stop following the project
  tempo — the opposite of what a remix tool needs.
- **A new global `Ctrl+R` shortcut.** Recording is an occasional, transactional
  action reached from the transport; a global shortcut would be the only entry
  point to a modal that nothing else in the app opens by keyboard.
- **Low-latency software monitoring in the first release.** The honest options
  are exclusive-mode WASAPI or ASIO on the capture device plus a dedicated
  monitor path — a substantial feature in its own right, on a code path that
  does not exist yet.
