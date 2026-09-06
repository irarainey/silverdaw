# ADR 0030 — Audio recording: a standalone capture device, a recording bounded by a time window, and an on-grid library item

- **Date:** 2026-09-04 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Context

Plan §11.6 (issue #35) calls for a simple way to record live input — vocals, an
instrument, a line input, found sound — without Silverdaw becoming a multitrack
recording studio. This ADR records the design agreed **before** implementation,
so that the constraints it turns on are settled once rather than rediscovered
per pull request. Where it describes behaviour that does not exist yet it is
prescriptive, not descriptive.

The feature shipped in 1.9.0. Ten amendments follow the decision, several of
which reverse a position taken here — software monitoring and "every recording
is musical" most of all. **Read the amendments before relying on anything in the
Decision section**; where the two disagree, the amendment is what was built.

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
  Stop. A preroll cannot run before the start of the project, so when the anchor
  sits inside the first bar the anchor moves out to the bar line rather than the
  count-in being quietly dropped: a count-in that was asked for is always
  heard, and the recording simply starts one bar in. A range recording keeps
  its anchor, because its length is what makes its claimed beat count true.
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

Recording rolls the real transport rather than preparing a separate bed.
Nothing equivalent to `SCRATCH_BACKING_PREPARE` is built: an optional count-in
(one bar, or none) reuses the existing metronome, and the take is played against
the arrangement as it stands.

Which tracks that means is a *session* choice, made in the dialog's **Backing**
list: all of them, some, or none for an unaccompanied take. Deferring to mute
and solo alone was tried first and rejected — muting three tracks to record over
the fourth is an edit to the project, it marks the file dirty, it lands in the
undo history, and the user then has to remember to put it back. Instead the
session borrows engine-level audibility (`setTracksAudible`, the seam mute and
solo already drive) for as long as the dialog is open, exactly as it borrows the
click. The project's mute and solo are never written, and the arrangement is
handed back untouched when the dialog closes.

One rule bounds it (`backingTrackAudible`): while a session is open the
selection alone decides what is heard, and with no session the project alone
decides. The borrow therefore runs in both directions — a track the timeline is
muting can be ticked into the backing for one take, and is muted again the
moment the dialog goes. That is deliberate: what a performer wants to play
along to is a different question from what the arrangement should sound like,
and answering the first must never change the answer to the second. To keep the
default honest the selection is *seeded* from what the timeline is currently
playing, mute and solo folded in, so the dialog opens sounding like the
arrangement and any departure from it is something the user asked for. The
selection applies to the review audition as well as the take, and is locked
while rolling — it is what the performer is playing to.

How *loud* that backing sits under the performer is the same borrow applied to
level. The dialog's **Volume** slider is a 0..1 monitor trim on the arrangement
that lasts exactly as long as the session (`sessionBackingGain`). Two nearer
alternatives were rejected: the project's master volume, because that is a
project edit with all the dirty-file and undo problems that made mute the wrong
answer for the selection; and per-track gain, which would have to be written back
through every clip and would fight any edit made while the dialog is open.
Instead the trim sits on `MasterClockSource`, upstream of master gain. That
position is the point of it — the click and the preview voice are mixed
downstream of that source, so turning the backing down leaves the count-in
audible and the review audition of the take at full level, which is precisely
what someone reaching for the control wants. Unlike the selection it stays live
while rolling: level is monitoring, it changes nothing about what is captured,
and a performer buried under the arrangement should not have to abandon a take to
fix it.

The record window, backing (both which tracks and how loud), count-in and click
are remembered by the renderer between dialog opens: they describe the take being
chased, not one session.
They are app-session state rather than a preference or project data — the
backing is a list of track ids that only means anything in one project — so a
setting the user has not touched keeps the backend's seed, and a remembered
backing whose tracks have all gone defers to the seed as well.

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
  not have to lose the take to fix it. It is remembered with the input device
  preference, because a microphone's level is a property of the setup rather
  than of one take.
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

### A session borrows the metronome, in both directions

A count-in forces the click on for the preroll and hands the metronome straight
back at the anchor, so what the performer hears through the take itself is the
project's own metronome setting. The dialog exposes that setting rather than
owning a second one, and the click is monitoring only: it is mixed post-master
into the output, never into the capture.

Review borrows it the other way, forcing the click **off** for as long as the
dialog holds a finished take. Auditioning "with the arrangement" rolls the real
transport, so a click there sounds exactly like one baked into the recording,
and judging a take means hearing what was captured and nothing else. One rule,
`sessionMetronomeEnabled(status, projectEnabled)`, decides this for every status
so the borrow can never leak: the project's setting is what survives the dialog,
and it is never written by the session.

Bleed of the backing or the click into a take is therefore always acoustic (or a
loopback input chosen as the source): the capture device is opened input-only
and the tap writes nothing but its input channels. Measured on the development
machine, output through headphones produced no measurable energy in the capture
at all, while output through the laptop speakers raised its noise floor
threefold — the mitigation is monitoring, not code.

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

> **Verified in 1.9.0.** The capability is declared and the packaged behaviour
> is now known. Installing the signed `1.9.0` package registers
> `<DeviceCapability Name="microphone"/>` and Windows creates the consent-store
> entry `Silverdaw_<hash>` set to `Prompt`. There is **no install-time
> permission dialog** — Windows resolves a device capability at first use. The
> silence failure path above therefore remains the primary safety net, because
> the backend has no window for a consent prompt to attach to.

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

## Amendments

### Amendment 1 — Software input monitoring is in, opt-in and best-effort

The decision above ruled software monitoring out entirely. Use showed that to be
wrong for the common case this feature exists for: recording a vocal over a
backing. A performer wearing headphones hears the arrangement and hears nothing
of themselves, and no amount of pointing at "your interface's direct monitoring"
helps someone using the laptop's own microphone, which is exactly the audience
Silverdaw is for.

Monitoring is therefore a session control (`setMonitorEnabled`), **off by
default**, implemented as `recording::InputMonitorSource` — a `juce::AudioSource`
added to `topMixer` alongside the scratch and backing sources, fed by
`InputCaptureTap` through a lock-free `juce::AbstractFifo` ring.

What this deliberately does not claim:

- **It is not low latency.** The original latency argument still holds: on
  shared-mode WASAPI across two devices this is a round trip of tens of
  milliseconds. It is useful for pitching and phrasing, not for judging timing,
  and the recorded file is unaffected either way — monitoring is downstream of
  the tap, and latency is still corrected offline at finalise.
- **It is best-effort across two clocks.** Capture and output remain separate
  devices with separate clocks (that decision is unchanged), so the ring will
  eventually over- or under-run. It drops the oldest audio on overflow and plays
  silence on underrun rather than blocking either thread, and counts both.
- **It is a feedback risk.** A monitored microphone in front of speakers will
  howl. That is why it is opt-in, why the control says "use headphones, or it
  will feed back", and why `sessionMonitorAudible(...)` forces it off in review
  and with no session at all.

### Amendment 2 — A recording is musical *by default*, not always

"Every recording is musical" above is right for the feature's main use and wrong
for its edges: a spoken intro, a sound effect or a found recording has no tempo,
and giving it one means the clip shows beat markers that describe nothing and
warps when the project tempo changes.

The dialog therefore offers a **recording mode**, and it maps onto the library's
existing `audioType` rather than introducing a recording-only concept:

- **Music** (the default) is the behaviour described above — project BPM,
  `beatAnchorSec`, `audioType = "music"` and, where the window makes it true,
  `musicalBeats`.
- **Simple** commits `audioType = "simple"` with no tempo and no beat count,
  which is what already suppresses beat markers everywhere in the app and is
  exactly what the Scratch Editor's bake does.

The mode changes nothing about the capture, so it is read at commit and can be
changed right up to keeping the take.

### Amendment 3 — Optional post-record noise cleanup

A close microphone in a bedroom records a constant low-level bed that is
inaudible while performing and obvious in the gaps once the take sits under a
mix. `recording::cleanRecording(...)` is an opt-in pass, run on the worker
thread after finalise and before the peaks are computed, so the waveform the
user reviews is the audio that was kept.

It is deliberately conservative, because a cleanup that eats breaths and word
tails does more damage than the noise it removed:

- An 80 Hz high-pass, below any sung or spoken fundamental and above hum and
  stand rumble.
- A downward expander keyed on the take's **own** measured floor — the tenth
  percentile of its window RMS, so one silent block cannot claim a floor no real
  recording has — with a bounded reduction rather than a gate to silence.
- A take already quieter than the pass could usefully act on is left completely
  untouched rather than rewritten for no gain.

A cleanup that fails is logged and the original take is kept: a take that could
not be cleaned is still a good take.

### Amendment 4 — A third record window: From Start

"Two modes, and no more" held while both modes were relative to something the
user had already positioned. It missed the most common way a remix is built up:
the take is meant to run over the whole arrangement from the top, and getting it
there meant moving the playhead first, or drawing a range over the entire
project just to say "the beginning".

**From Start** anchors at 0 and, like From Playhead, runs until Stop. It adds no
new concept — it is one more answer to the anchor question `resolveRecordWindow`
already asks, and it carries no end, so nothing downstream (auto-stop, tail trim,
claimed beat count) changes. The count-in rule above applies unchanged and is
most visible here: a counted-in take From Start begins at the second bar, because
the preroll has to play somewhere and the alternative is dropping the count-in
that was asked for.

### Amendment 5 — A session holds the project's loop off

The record window promises a take over a selected range stops at the end of that
range. A looping selection broke that promise: the engine wraps the transport on
its own timer, so the position never reached the range end the session was
watching for, and the take ran round the loop until Stop was pressed by hand.

A session now holds the loop off for as long as the dialog is open
(`AudioEngine::setTimelineLoopSuspended`), alongside the click, the backing
selection, the backing level and the monitor. The hold suspends rather than
disarms: the range stays exactly as the project armed it, so releasing the hold
on close restores what the user had without the session having to remember and
replay it - and without racing whoever else sets the range.

The same close path is what hands every borrowed piece of engine state back, so
it must not be possible to skip. Two ways it could be: a dialog that never
adopted a session id sent no close at all, and a second open over a session that
had been abandoned that way was refused rather than replacing it. Closing with
an empty id now means "whichever session is open", and opening retires an
abandoned session first. An abandoned session was the one way the click could
outlive the dialog.

### Amendment 6 — The cleanup denoises first and expands second

Amendment 3's cleanup was a broadband downward expander, and in use it did not
sound like it did much. It could not: an expander turns the *whole* take down,
and only once all of it has fallen below one threshold. It therefore never
touches the bed underneath a held note or a spoken word — the bed only comes
down when nothing else is happening — and in speech it barely closes at all,
because the gaps between words are shorter than the envelope's release. Two
implementation faults made it quieter still: the gain was smoothed with the
release coefficient in *both* directions, so it also opened slowly and ducked
the front of every phrase, and the release itself was long enough that a
sub-half-second gap ended before the gain had closed.

A hand-written spectral suppressor was written and rejected. It worked, but it
duplicated a capability the repository already ships and had to guess a noise
profile from the take, which is exactly the part that is hard to get right: on
a take with no clear gap it mistook a sustained note for the bed and suppressed
the performance.

The cleanup now runs the chain the vocal stem cleanup already uses, in the same
order and for the same reasons:

1. The 80 Hz high-pass, unchanged. The denoiser was not trained on rumble.
2. `VocalDenoiser` — the vendored RNNoise suppressor. This is the stage that
   does the work. A network trained on speech in noise removes the bed from
   *under* the performance, which is the part no expander can reach, and it is
   run short of fully wet so a gap still sounds like a room rather than like a
   mute.
3. The expander, on what the denoiser left, keyed on the **residual** floor
   measured after it. Its job is now only the bleed that survives between
   phrases, which is a job an expander is actually good at. Its threshold has to
   be re-measured: the floor from before the denoiser sits far above the bed
   that is left, and would take the performance with it.

The expander's two faults are fixed with it: the gain now moves on the attack
when opening and the release when closing, and the release is short enough to be
closed well inside the gap between two words.

Reusing the stem denoiser rather than writing a second one is the whole point of
the change. It is already tuned, already tested, already offline and
worker-safe, already a guaranteed no-op when it fails, and it is the same
problem — a vocal with a noise bed under it. The cleanup is still opt-in, still
conservative, still skips a take that is already clean, and a cleanup that fails
is still logged with the original take kept.

### Amendment 7 — What a fresh dialog offers

The defaults were assembled piecemeal as each control was added, and two of them
inherited state rather than starting from a stated position. With nothing
remembered — the first open of an app session — the dialog now offers:

| Setting | Default | Why |
| --- | --- | --- |
| Record window | **From Start** | A take over the whole arrangement needs no setting up, and it is the only window that is always valid: the playhead and the range both depend on where the user happens to have left something. |
| Count-in | None | Nothing that delays the take without being asked for. |
| Click While Recording | **Off** | Was seeded from the project's metronome. A project that clicks while arranging is not a request to click through a take, and the inherited value made the click look like a setting the dialog had chosen. |
| Backing | The arrangement | Every track the timeline is currently playing, mute and solo folded in, at unity — so the default sounds like the project does. Seeded by `open`, because it is the one default that cannot be a constant. |
| Hear Yourself | Off | Monitoring routes an open microphone into the output; it has to be asked for. |
| Recording mode | **Music** | A take laid over an arrangement is musical far more often than not, and the mode only adds tempo and beat markers — nothing is lost if the take turns out not to be. |
| Clean Up Background Noise | Off | It changes the audio that is kept. A pass that alters the take must never run unasked. |

`RecordingStateSnapshot`'s member initialisers state all of this in one place,
bar the backing. The rule behind the two that changed: a default may inherit
what the user can *see* (the arrangement they are recording against), but not
what they will *hear* or *keep* without having chosen it.

### Amendment 8 — The review has its own backing level

The dialog's backing volume is a guide level: how far the arrangement has to come
down for the performer to hear themselves over it. Reviewing the take at that
same level is the wrong answer — the point of the review is hearing the take
sitting in the arrangement, not hearing the guide mix again.

The review pane therefore keeps its own remembered backing level, 100% until it
is moved, applied when the pane mounts and handed back to the setup's level when
it unmounts, so a retake plays to the guide mix again. Both sliders drive the one
`setBackingGain` control: there is a single engine trim
(`setArrangementMonitorGain`) and the two panes take turns holding it, rather
than the protocol growing a second gain for a difference that only exists in the
UI. Like every other borrow it is engine-only and gone the moment the dialog
closes.

The review waveform is drawn normalised for the same kind of reason: a take
recorded at a sensible level peaks well below full scale, and drawn literally it
is a thin line in a tall box. The loudest peak is scaled to 94% of the box, up to
8x, and the file and its peaks cache are untouched.

### Amendment 9 — Save as Stereo rewrites the take at review time

A mono take is a one-channel file, and stays one when it is saved. That is
usually right, but a mono vocal or instrument sitting in a stereo arrangement is
often wanted as a stereo clip: some downstream work (stem separation, export,
per-channel editing) treats a one-channel file differently, and the user should
not have to convert it outside the app.

**Save as Stereo** in the review pane duplicates the take into both channels. It
is offered only for a mono take, and it runs *when it is ticked*, not at commit:

- The audition then plays the exact file that will be saved. JUCE already reads a
  mono file up into a stereo target, so the sound does not change — but "what you
  heard is what you saved" is worth more than saving one file rewrite.
- Both forms are kept on disk (a `… (stereo).wav` sibling), so toggling is
  instant and reversible; the unused one is deleted at commit, discard or close.
- The take is re-finalised, its peaks recomputed and stored, and
  `RECORD_RECORDING_READY` re-broadcast, so the review pane redraws from the file
  it is now auditioning rather than tracking two states.

The duplicate is built on the message thread rather than the peak pool, unlike
finalise. It is a block-streamed copy of a take that is minutes long at most, and
the dialog is idle and waiting for the user at that moment — a second pool
round-trip would buy nothing.

### Amendment 10 — A recording carries its grid on SAMPLE_SAVED

A committed musical recording appeared in the library with its tempo and beat
markers missing, so it read as a simple clip until the project was reloaded.

The grid *was* being broadcast, as `LIBRARY_ITEM_ANALYSIS` from
`applyManualTempo` — but synchronously, before `SAMPLE_SAVED` was sent, and
`setItemAnalysis` returns early for an item the renderer does not have yet.
Swapping the two broadcasts does not fix it: the renderer's `SAMPLE_SAVED`
handler is async (it awaits the peaks cache), so the analysis can still arrive
first. A recording also has no `sourceItemId`, so the inherit-from-source path
that gives every other saved sample its grid never runs.

`SAMPLE_SAVED` therefore carries `bpm` and `beatAnchorSec` for a musical
take, exactly as it already carries `musicalBeats`, and the renderer
synthesises the rigid grid from them once the item exists. Message ordering stops
mattering, which is the same reason the `musicalBeats` field exists.
