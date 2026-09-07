# ADR 0030 — Audio recording: a standalone capture device, a recording bounded by a time window, and an on-grid library item

- **Date:** 2026-09-04 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Context

Plan §11.6 (issue #35) calls for a simple way to record live input — vocals, an
instrument, a line input, found sound — without Silverdaw becoming a multitrack
recording studio. This ADR records the design agreed **before** implementation,
so that the constraints it turns on are settled once rather than rediscovered
per pull request. Where it describes behaviour that does not exist yet it is
prescriptive, not descriptive.

The feature shipped in 1.9.0. Twenty-four amendments follow the decision, several
of which reverse a position taken here — software monitoring and "every
recording is musical" most of all. **Read the amendments before relying on
anything in the Decision section**; where the two disagree, the amendment is
what was built.

Three facts in the current codebase shape the whole design.

**Everything downstream of import assumes a finished file.** A `CLIP` references
a `libraryItemId`, which references audio on disk; peaks are computed from that
file and cached; warp, envelopes, brake and backspin all read it non-destructively
(ADR 0007). There is no concept anywhere of a clip whose audio is still being
produced.

**The engine is deliberately opened output-only.**
`AudioEngine::openDefaultOutputOnly()` says why:

``cpp
// Request the default output with NO input endpoint: an empty input device plus
// useDefaultInputChannels=false stops JUCE opening the default capture client,
// which is the tens-of-seconds stall on a problematic default mic.
``

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
- Registering the category means five places: the `kCategories` list in
  `ProjectSession.cpp`, the folder→kind map in `ProjectStateLibrary.cpp`, the
  cross-project import scan (`ProjectImportSource.cpp`,
  `ProjectImportCommands.cpp`) so that "import assets from another project" sees
  recordings, and the Electron main audio path allow-list (`audioPaths.ts`,
  registered from `projectHandlers.ts` and `stemHandlers.ts`) so the renderer
  may decode a take's WAV for its waveform. Portable relative-path rewriting is
  already generic.
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
> the backend has no window for a consent prompt to attach to. Capture has since
> been exercised on a signed MSIX install on real hardware and works, so the
> consent path is confirmed end to end rather than only at registration.

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

### Amendment 11 — The count-in is stationary

A count-in was costing the take the bars it counted. `resolveCountInAnchorMs`
moved the anchor forward whenever there was no arrangement in front of it to
count over — which, for the From Start window, is always — so a four-beat count
started the recording a bar into the timeline and left that bar empty.

The count-in no longer moves the anchor and no longer rolls the transport. The
transport is parked at the anchor, the click runs for the counted beats, and only
when it expires does the writer attach and the transport start. The anchor is
whatever the window asked for, and the take begins exactly there.

The click needed its own path to make this work. `MeteringSource` renders the
metronome only when the transport advanced during the block, so a parked
transport was silent; a count-in now drives the same click off a free-running
sample counter that does not consult the clock. The audio callback still runs
while stopped — `OutputKeepAlive` holds the endpoint open — so the click is
audible with nothing playing.

Two consequences follow. Nothing is captured during the count-in, so the preroll
trim is gone and `headTrimMs` is round-trip latency alone; and stopping during a
count-in abandons it rather than finalising a take of zero samples, which would
otherwise have failed the silent-input check and reported that the input
delivered no signal.

The monitor stays audible through the count-in, so a performer can hear
themselves against the click before the take starts.

### Amendment 12 — The head trim measures the transport start rather than assuming it

A take laid over a backing track landed roughly a quarter of a beat late. The
compensation was directionally right — the performer hears the arrangement late
and Silverdaw receives them late, so the round trip comes off the head — but it
was built on an assumption that does not hold: that capture and the transport
start at the same instant.

They do not. The writer is attached first, and `play()` then spends real time on
the message thread flushing rebuilds, refilling read-ahead buffers to a budget of
seconds, and priming the plugin pipeline. On a sleep-prone endpoint the audio
thread may then burn a 250 ms wake pre-roll that deliberately emits silence
*without advancing the playhead*. Every millisecond of that is captured audio
that precedes the arrangement, and none of it was trimmed.

`MasterClockSource` now stamps, from the audio thread, the instant of the first
block that genuinely advances the transport, and tags it with a monotonic play
epoch. `InputCaptureTap` already stamped its first written block. The head trim
is the gap between the two, plus the round trip:

``text
headTrimMs = max(0, (transportStart - firstCapturedBlock) + outputLatency + inputLatency)
``

Three properties of that formula are load-bearing.

**The skew is signed.** The first written input block landing *after* the first
advancing output block is entirely normal — the two devices' callbacks are
independent and interleave however they interleave. Clamping the skew at zero
would push those takes early by up to a full input period. Only the combined trim
is floored.

**The epoch is checked.** A stamp belongs to exactly one play. A block still in
flight across a fast stop/restart, or a stamp left over from a previous play,
describes nothing about this take and is refused, falling back to the plain round
trip.

**Plugin delay compensation is excluded.** This is the counter-intuitive one.
`primePluginPipeline` pushes the alignment through the delay lines *before* the
gate opens (ADR 0026), so the first live block already carries anchor audio and
the performer never waits the alignment out. `PlayheadEmitter` subtracts it only
because the raw sample counter was run ahead to compensate — a counter offset,
not an audible delay. Adding it here would drag every take early by the whole
alignment.

Recording also now owns the transport outright. Ordinary `play()` cannot start a
take: a seek requested while the transport is rolling is deferred behind an output
fade, and `play()` then merely cancels that fade and returns *without seeking,
priming, or starting a new play* — so a take begun that way captured whatever
region happened to be playing, with no start stamp to trim against.
`playFromAnchorForRecording` parks the transport, applies the seek immediately and
opens a genuine new play, and reports whether it succeeded; a take is abandoned
rather than begun against a transport that never started. The dialog pauses
project playback when it opens, so that park happens from rest.

Two related corrections fall out of the same reasoning. A bounded window now stops
capture a round trip *after* the raw transport reaches the window end, because the
performer is playing to what they can hear, not to the raw counter — stopping on
the counter truncated the last notes of every ranged take, and offline trimming
cannot put them back. And the head trim is converted to samples at the *measured*
capture rate rather than the nominal one, because it is applied before drift
correction, where one second of captured wall time holds `measuredRate` samples.

None of this can reach exactly zero. The estimate is only ever as good as the
latency the driver reports, and shared-mode WASAPI reports a bound rather than a
measurement. What it does remove is every source of error that is Silverdaw's own
to remove. Closing the remaining gap needs either a user-set offset or an acoustic
loopback calibration, and neither is decided here.

### Amendment 13 — Deleting a take must be able to clear the dirty flag

Record a take, put it on a track, then remove the track and delete the take again
and the project stayed marked unsaved, with nothing left in it to point at. The
cause was not in recording at all — recording just made it easy to hit.

A take's audio lives in the project's own `recordings/` folder, so deleting the
library item deletes that file: irreversible, and therefore neither undoable nor a
dirtying edit (Amendment 8, and the same rule that already governs stems). That
removal runs through `removeLibraryItemNonDirty`, which suppresses the dirty
listeners and mirrors the removal into the clean snapshot so the tree stays
equivalent to what was saved.

Suppression, though, is symmetric: it stopped the flag being *raised*, but it also
stopped it being *lowered*. The flag was left at whatever it was when the removal
started — and an item added since the last save is precisely what an unsaved
project is usually dirty about. The tree was back to the saved state and the marker
disagreed.

The removal now recomputes the flag once, outside the suppression scope, from the
tree itself. Nothing about the removal marks the project dirty, and a project that
is dirty for any other reason stays dirty; what changes is that when the item taken
away was the last outstanding difference, the project is correctly clean again.
This is Silverdaw's existing net-zero rule — the flag is a comparison against the
clean snapshot, not a latch — reaching a path that had been quietly exempt from it.

### Amendment 14 — A take imported from another project is still a take

The original decision registered `recordings/` with the cross-project importer so
that "import assets from another project" would *see* recordings. It saw them, but
it could not tell them apart: the manifest grouped by library kind, and a take is a
sample by kind, so a take arrived filed among the samples with its
`recordingOrigin` marker dropped on the way in.

That is the wrong end of the trade the category folder exists to make. The marker
is additive precisely so a take can be an ordinary sample everywhere it needs to be
while still being identifiable as a performance; an import that discards it makes
the destination project unable to say where its own audio came from, and does so
silently.

The importer now carries a take's *category* — the artifact folder holding the
file — alongside its kind, and that is what decides all three things kind was
being asked to decide: the group it is offered under (its own **Recordings**
heading, beside Stems and Samples), the folder it is copied into (the destination
project's `recordings/`, filed exactly as that project files its own takes), and
the `recordingOrigin` restored on the new item. Containment, not the persisted
flag, is what identifies a recording on the way out, so a take whose provenance was
somehow lost still imports back as a recording.

One consequence is worth naming: a take this project recorded sits directly in
`recordings/`, but an imported one gets its own `import-<id>` folder like every
other imported asset. Artifact cleanup was only pruning those per-asset folders
under the other roots, so an imported take's folder would have been left behind
empty once its file was deleted. `recordings/` is now pruned the same way.

### Amendment 15 — Drift is measured against the output clock, and only corrected when it can be seen

Amendment 12 closed the constant part of the offset. What was left behind was a
*rate* error, and it showed up in the way that matters most: a performer who
overdubs is playing along to what they can hear, so each take inherits the timing
error of the take before it. The errors add rather than average, and by the third
or fourth layer the arrangement no longer agrees with the project tempo.

Two defects were behind it, and both are in the measurement rather than the
correction.

**The drift was measured against the wrong reference.** `speedRatio` was
`measuredInputRate / nominalRate`, where the measured rate was input frames per
wall-clock second. But the timeline the take will sit on does not advance at the
nominal rate — it advances at the **output device's** rate, and input and output
are usually separate devices on independent crystals. Only the ratio *between*
them is audible as drift; a shared departure from nominal is not drift at all,
and correcting for it injects an error. The ratio is now
`measuredInput / measuredOutput`, which has a second useful property: both rates
are measured against the same wall clock, so any error in that clock is
common-mode and cancels exactly.

**A two-endpoint span cannot resolve what it was being asked to resolve.** The
old estimate divided the captured frames by the gap between the first and last
callback stamp, so the scheduling noise at each end landed undiluted on the
answer. Its fractional error is roughly that noise divided by the span: with a
millisecond of jitter, five seconds of audio yields ~280 ppm — several times
*larger* than the 20–100 ppm of genuine crystal mismatch it exists to correct.
The gate compounded it: a five-second minimum span paired with a 1 ppm
correction threshold meant it fired on almost everything, and corrected by far
more than the error it was correcting.

`ClockRateEstimator` replaces both with a least-squares fit of frames delivered
against a stamp taken at each callback's entry, decimated into a fixed buffer so
a long take costs bounded memory while still spanning its whole length. The fixed
gap between "buffer filled" and "callback entered" is a constant, which the
fitted intercept absorbs without biasing the slope. One outlier-trimming pass at
three residual sigma keeps a single stalled callback from tilting the line.

The estimator's real contribution is that it reports **how uncertain it is**, and
that is what now gates the correction: drift is applied only when the ratio
stands three standard errors clear of unity and inside a plausible ±2000 ppm.
Otherwise it is logged and skipped, and the take is written through untouched.
This is the load-bearing reversal. The old design assumed that some correction is
always better than none; the opposite is true under overdubbing, because
resampling by a noise reading adds a per-take tempo error, and it is precisely
that error which stacks. Refusing to act on a measurement that cannot see the
thing it is measuring is the safe answer.

The output estimator is fed from `MasterClockSource::getNextAudioBlock` before
any early return, against a monotonic device-frame counter that ignores the
transport entirely — seeks, loops and stops must not appear as rate changes. It
therefore accumulates from the moment the device starts and is reset only in
`prepareToPlay`, where a device change invalidates the baseline anyway. This is
deliberate: the output clock is a property of the device, not of a take, so a
long session earns a progressively tighter estimate that every subsequent
recording benefits from. The input estimator is reset per take with the rest of
the capture statistics.

Two limits are worth naming. This corrects a *rate*, not a constant offset, so
whatever residual the reported driver latency leaves is untouched — that still
needs a user offset or an acoustic loopback, and neither is decided here. And a
take too short to accumulate `kMinPoints` blocks is never rate-corrected; over a
few seconds, tens of ppm is microseconds, so there is nothing there to correct.

### Amendment 16 — Opening the session comes before enumerating the drivers

`enumerateCaptureInputs` scans every driver type, and its own comment has always
said what that costs: hundreds of milliseconds, on the backend's message thread,
which is where every command handler runs. The dialog asked for the device list
first and the session second, so `RECORD_SESSION_OPEN` sat in the queue behind
that scan.

The consequence was out of proportion to what was being waited for. The device
list fills exactly one dropdown; `RECORD_SESSION_STATE` fills everything else —
window, count-in, click, backing, monitor, gain, mode, channels — so ordering the
scan first parked the *whole* form behind a scan that only one control needed.
On the first open of an app session, where the cache is empty and the scan is
genuinely slow, the dialog appeared as a shell of disabled controls holding
hardcoded defaults, which then visibly snapped into place.

The order is now reversed: session first, list second. Nothing depends on the
other way round — the session opens on the device remembered in preferences, not
on anything in the enumerated list — so this is ordering, not redesign, and the
protocol is unchanged.

Two rules follow from it, and they are the part worth keeping.

**A control with a remembered value shows it immediately.** Every dialog setting
already has a `remembered*` counterpart that the session re-applies the moment it
opens (Amendment 7). Falling back to those while the state is in flight shows
what the dialog is *about to* settle on, rather than a hardcoded default that
will be replaced a moment later. It is showing the truth early, not guessing.

**Waiting is stated, and never as a failure.** An empty picker used to read "No
input available" while the scan was still running — an alarming thing to say to
someone who is about to record, and untrue. It now names the device the session
was asked for, or says it is still looking, and reports no input only once the
scan has actually come back empty. A wait cursor and a spinner carry the rest.

### Amendment 17 — Windows cannot report the round trip, so measure it

Amendment 12 trims the head by what the drivers declare: output latency, input
latency, and the measured transport skew. On the hardware this was developed
against those numbers came to 11.6–18 ms. The real round trip was 60–135 ms.
Takes landed roughly a quarter of a beat late, and dragging every clip back by
hand is exactly the kind of tedium this feature exists to remove.

The gap is not drift. Amendment 15's estimator reported −1.4 to −5.7 ppm over a
nine-second take — about 0.05 ms, three orders of magnitude too small to explain
it. It is a constant under-compensation, and the reason is that the numbers
being trusted are not measurements. A processed capture endpoint — the DSP mic
arrays now standard on laptops — declares no latency at all while adding tens of
milliseconds of beamforming and echo cancellation. A shared-mode output reports
its own buffer and nothing of the mix graph, the DAC, or the USB stack beneath
it. `outLatencyMs=10.0` at `buffer=480 sr=48000` is the buffer size restated,
not a measurement.

Nothing in the operating system knows the answer, so nothing can be asked for
it. **The only ground truth is acoustic loopback**: play something, hear it come
back, time the gap.

**A run plays twelve tone bursts 300 ms apart and times each echo.** A burst
rather than an impulse, because no speaker can reproduce an impulse. Onsets are
timed, not peaks — timing the peak would report a round trip several
milliseconds too long. The burst's envelope is a fast attack, a flat sustain and
a short release rather than a window over the whole burst, which is what lets it
be long and loud enough to hear clearly while its leading edge stays sharp
enough to time. It sits at 3 kHz, where hearing is most sensitive and above the
speech band a microphone's echo canceller works hardest on.

**The emission stamp is taken when the burst is written into the output
buffer**, not when the timer fired. That is the same reference point the
arrangement's own audio is generated from, and the same one
`measuredTransportSkewMs` uses, so the measured quantity is the one that matters
to a take. The stamp includes the burst's sample offset within the block.

**Each echo is matched to the emission it most recently followed**, by smallest
non-negative delta rather than by index. A burst swallowed by echo cancellation
then costs one reading instead of corrupting every reading after it.

**A number is reported only when the readings corroborate each other.** The
median is taken, a majority must fall within 12 ms of it, and only that cluster
is averaged. Scattered readings return nothing at all. A calibration that
silently reports a wrong number is worse than one that admits it failed, because
the wrong number is then baked into every take.

**A calibrated round trip replaces the driver figures; it does not add to
them.** The measurement already contains everything the drivers would have
reported, plus everything they could not see. Adding the two would double-count
the buffer.

**The result is stored in application preferences, not the project.** Latency is
a property of the machine and its devices, and projects must stay portable
between them. It is keyed on the input and output device pair; sample rate and
buffer size are recorded as fields rather than as part of the key, so changing
them warns that the measurement is stale instead of silently discarding it.
Changing device falls back to driver behaviour and says so — reusing a
measurement from other hardware would be a guess wearing the clothes of a
measurement.

**Calibration is offered, never forced.** It does not auto-prompt, it does not
block recording, and it does not gate the dialog. What it does do is state
plainly whether the current device pair has been calibrated, because someone
whose takes are landing late needs to be able to find the reason. The entry
point sits under the input device picker, where the choice it qualifies already
is, and opens a dialog of its own.

**Manual entry is the fallback, not the plan.** Acoustic loopback needs the
output to reach the microphone, which usually means speakers — but holding one
earpiece of a pair of headphones against the microphone measures the same round
trip, so headphones are not excluded. What can defeat it is an aggressive echo
canceller suppressing the bursts, and for that a hand-typed figure is the way
out. It is marked as manual so a later run cannot quietly overwrite it.

Two things are deliberately left alone. Plugin delay compensation still stays
out of the head trim, for the reasons Amendment 12 gives. And the capture
temporary file goes to the system temp directory rather than the project's
`recordings/` folder — it is deleted immediately, and calibration has to work
with no project open.

## Amendment Eighteen: a take keeps a little audio in front of the anchor

Amendments 11, 12 and 17 between them land a take exactly on the anchor: the
whole round trip and the transport skew are trimmed off the head, so the first
sample of the finished file is the audio the performer played at the anchor.
That is correct and it is still wrong, because a performer does not play at the
anchor. They play a few milliseconds either side of it, and the early side gets
its attack shaved off by the trim. A vocal consonant or a struck drum loses
precisely the part that carries the timing.

**A take is trimmed to `anchor − preRoll` rather than to the anchor, and placed
at `anchor − preRoll` on the timeline.** The two cancel: the audio played on the
anchor still sits on the anchor, and what came fractionally before it now sits
fractionally before it, where it was played. Nothing about the alignment model
changes — the same head trim is computed the same way, and part of it is simply
kept rather than discarded.

The pre-roll is 120 ms. That is well beyond the few milliseconds a performer is
early by, and short enough to stay inside a single beat at any plausible tempo,
so a take never reaches back over the beat before it.

**It is bounded three ways, and the third is not obvious.** It cannot exceed
what was captured ahead of the anchor, because a lead-in cannot be invented. It
cannot exceed the anchor, because nothing sits before the start of the timeline.
And it is refused outright for a take that claims a beat count: `musicalLengthBpm`
divides that count by the file's whole duration to recover a tempo, so a lead-in
would make the take read as slower than it was played, and every clip stretched
to it would drift.

**With a count-in, the capture opens 250 ms before the count expires** rather
than at the moment it does. Otherwise the lead-in is wishful: the transport is
parked through a count-in, so a capture that only opens when it ends has nothing
in front of the anchor to keep. The open is bounded rather than moved to arm
time because the head trim is *measured* — if a transport start stamp is ever
unavailable the trim falls back to latency alone and the untrimmed remainder is
whatever was captured early. A quarter of a second of count-in at the head of a
take is a blemish; two bars of it is a broken take.

**The review audition has to know.** It rolls the arrangement against the take,
and it now seeks to `anchor − preRoll` rather than to the anchor, so the take is
heard against the backing exactly where it will sit. Auditioning from the anchor
would play the take a pre-roll late against the very backing it was recorded to
— which is the bug the head trim exists to prevent, reintroduced in the one
place a user would go to check for it.

## Amendment Nineteen: the live waveform is drawn on the timeline

The waveform drawn while a take rolls is built from the input meter, not from
audio (ADR 0003 keeps samples off the socket), and it was drawn as though the
take began at the left edge on beat zero. Neither is true, and both errors are
visible: a performance that plays back perfectly in time looked out of time
while it was being recorded, which is worse than a cosmetic flaw — it invites
someone to correct a timing problem that does not exist.

**Input arriving now is a performance from a round trip ago.** The performer
heard the backing late and Silverdaw heard them late again, so a note played on
the beat reaches the meter a round trip after the transport passed that beat.
Drawing the first column at the anchor therefore pushes an on-time take a round
trip behind the grid — exactly the offset the head trim removes at finalise. The
first column is instead placed at `anchor − latency`, so the live picture shows
the take where the finished file will put it. With a calibration in force that
offset is often over 100 ms, a fifth of a beat at 120 BPM, and plainly visible.

**The round trip is sent, not recomputed.** `RECORD_SESSION_STATE` carries
`latencyMs`, produced by the same `effectiveRoundTripMs` the head trim uses, so
the figure the waveform is drawn against is by construction the figure the take
is trimmed by — including the substitution of a calibration for the driver sum.
A renderer-side copy of that rule would be free to drift out of step with it.

**Beats are numbered from the start of the timeline, not the start of the
take.** A take started from the playhead rarely begins on a beat, so a grid
measured from the left edge sits under the wrong audio, and its bar lines fall
on the wrong beats of the bar. `liveBeatFractions` takes the timeline position
of the view's left edge and derives absolute beat indices from it.

This changes only what is drawn. No captured audio and no alignment behaviour
depends on it, and the live view remains a picture of the input rather than of
the file — the real waveform still arrives with the finished take.

## Amendment Twenty: the capture buffer is the driver's, and the driver type is chosen by period

Monitoring delay is the round trip, and the round trip is mostly the two device
buffers, so shortening the capture buffer looks like the obvious lever. It is
not a lever at all, and the way it fails is dangerous enough to record here so
that nobody tries it twice.

**A shared WASAPI endpoint advertises buffer sizes it will not honour.** The
capture device on the test machine offers every size from 144 frames (3 ms) up,
and defaults to 480 (10 ms). Opening it at 256 succeeds, reports no error, and
reports an input latency of 5.33 ms — and then delivers 256 frames per 10 ms
period and **silently discards the remaining 224**. Measured over five seconds
with `SilverdawCaptureProbe --capture-buffer`, a 256-frame request captured
128000 samples where 240000 were rendered: 47% of the performance was thrown
away, with no dropped-block count and no fault reported anywhere. The shortfall
scales exactly with the request — 288 loses 40%, 320 loses 33%, 384 loses 20% —
which is the signature of a fixed device period being partially drained.

Capture therefore opens at `getDefaultBufferSize()` and nowhere else.
`getAvailableBufferSizes` is not trustworthy for an input in shared mode, and a
shorter buffer trades a few milliseconds of monitoring comfort for a corrupted
take. The probe keeps its `--capture-buffer` override so the claim stays
measurable rather than becoming folklore.

**The driver type is still worth choosing deliberately.** With the buffer fixed
at the driver's period, the period itself is what differs between types, and
"automatic" previously took whichever type the platform happened to enumerate
first. It now creates each candidate — creating is not opening, so this cannot
reintroduce the capture-open stall — and takes the one with the shortest
default period. Two types are excluded from automatic selection, both for
behaviour rather than speed:

- **Exclusive Mode** seizes the endpoint. While a take rolls nothing else on the
  machine can use the microphone, and worse for a default, opening fails outright
  if anything already holds it — which presents as an input that inexplicably
  will not start. It measured 20 ms against shared mode's 10 ms on the test
  machine, so it is not even the fast path its name suggests.
- **DirectSound** defaults to 2560 frames, 53 ms, against 10 ms for any WASAPI
  path. It remains available as a last-resort fallback and as an explicit choice.

Ranking by measured period rather than by name matters because the type named
for low latency is not one: "Windows Audio (Low Latency Mode)" runs at the same
10 ms period as plain shared mode and offers no other size at all. Preferring it
because of its name would be superstition, and would have locked out the shared
path that is at least as quick.

An explicitly chosen type is still honoured exactly as given. This changes only
what "automatic" resolves to, and can move a user's input latency, so a
calibration taken before the change may be a few milliseconds stale — well
inside the calibrator's agreement window, and recording is unreleased.

**None of this helps the monitor flam**, which is a closed loop through the
performer: any shift applied ahead of them is absorbed by them playing to what
they hear. Only a physically shorter round trip, or monitoring that never enters
the computer, changes it.

## Amendment Twenty-One: monitoring delay is stated, not compensated

The obvious next thought, having compensated the take for the round trip, is to
compensate what the performer hears by the same figure — shift the backing so
the voice they hear through **Hear Yourself** lands on the beat. It does not
work, and the reason is worth writing down because the idea is a good one right
up until it is examined.

**The performer is inside the loop.** Aligning the take is open-loop
bookkeeping: the timeline is a fixed reference, the take is late against it by
the round trip, subtract it, done. Monitoring is not. Delay the backing by the
round trip and the performer does not keep singing at the old moment — they sing
to the backing they now hear, a round trip later, and their voice returns a
round trip after that. **The flam is unchanged.** Any shift applied ahead of the
performer is absorbed by the performer. Closing it would mean emitting the sound
before the microphone captured it.

**Every comparable application agrees.** A survey of Tracktion Engine, Ardour,
Audacity, and the documented behaviour of six commercial DAWs found no product
that delays the backing to compensate monitoring, and no such technique in the
networked-music-performance literature either. What they all do is compensate
the *recording* — Tracktion's `DeviceManager::getRecordAdjustmentSamples()` is
literally `getInputLatencyInSamples() + getOutputLatencyInSamples()`, the same
sum as `effectiveRoundTripMs` — and then offer the performer a menu for
monitoring that is always some combination of: use the interface's direct
monitoring, shorten the monitor path, or turn monitoring off. Ardour's manual
puts software monitoring in the explicitly *non-compensable* bucket, in contrast
to recording, where "latency … can easily be compensated for".

**So Silverdaw states the figure instead of pretending to fix it.** With **Hear
Yourself** on, the dialog says how late the performer will hear themselves,
using the same `latencyMs` the take is trimmed by, and says plainly that the
delay is in what they hear and not in the take. That second half is the part
that matters: a performer who hears a flam will otherwise assume the recording
is being captured late and start compensating for a fault that does not exist —
which would genuinely damage the take, whereas the flam alone does not.

It is one short line, shown only while monitoring is on. Two earlier drafts were
rejected on layout grounds: three sentences of guidance resized the form when the
box was ticked, and folding the figure into the checkbox label would have
displaced the feedback warning, which is needed most exactly when monitoring is
on. Advice about *when* to monitor was cut with them — it belongs in the
documentation, not in a line that moves the dialog every time it is toggled.

That advice, for the record, is to leave monitoring off when the performer can
already hear themselves acoustically. For a singer or any acoustic instrument in
headphones the unmonitored path has no delay at all, so **off is the low-latency
option** and it is already the default. Monitoring earns its place for a quiet
or DI'd source that cannot be heard otherwise.

No attempt is made to drive interface direct monitoring. It is the real answer
to the flam, but it lives in the interface's own control panel, and a DAW that
claimed to switch it on would be lying on most hardware.

**Buffer size is not the escape hatch either** — Amendment Twenty measured what
happens when capture asks for less than the driver's period, and the answer is
that the take silently loses audio. The round trip is what it is.

## Amendment Twenty-Two: a lost input announces itself with silence

Pulling the capture device's cable mid-take was the last of the failure-mode
spikes, and it found a real defect. Measured on real hardware with the capture
probe, a USB microphone unplugged during a run stops calling back at the moment
the cable leaves the socket and **JUCE reports nothing at all** — neither
`audioDeviceStopped` nor `audioDeviceError` fires, and the device object still
claims to be open. `InputCaptureTap::wasDeviceStopped()` stays false forever, so
the controller's existing `deviceLost` branch could never run.

Left alone the session would sit in `recording` indefinitely, capturing nothing,
with no way out but Cancel — and if it were stopped, the take would be finalised
against a drift figure fitted over audio that stopped arriving. The same run
measured 1382 ppm, or 83 ms per minute, which would have been applied to the
file as if it were a real clock error.

**A stalled callback is therefore the only evidence of loss, so that is what is
watched.** `RecordingSessionController::timerCallback` compares the later of the
last delivered block and the moment capture opened against the clock, and calls
`finishCapture("deviceLost", …)` once the gap passes `kCaptureStarvationMs`.
Taking the *later* of the two means a device that never delivers a single block
is caught by the same rule as one that dies mid-take. The predicate is pure so
the threshold is tested without a device.

The threshold is 1500 ms, which is roughly thirty times the slowest driver
period Silverdaw will open — DirectSound's 53 ms. The margin is deliberately
lopsided because the two failure directions are not symmetrical: waiting a
second and a half to report a dead input costs the performer nothing they had
not already lost, whereas tripping early aborts a take that was going fine. No
new error plumbing was needed; `deviceLost` already surfaces as *"The input was
disconnected. Reconnect it, or choose a different input."*

**The same measurement confirmed the standalone-capture premise under the worst
case this decision anticipated.** While capture died, playback carried on
completely undisturbed — every callback delivered, no device restarts, the
output still open. Losing the input costs the input and nothing else, which is
exactly why capture is opened as its own device rather than folded into the
playback device.

## Amendment Twenty-Three: reviewer findings, and the rules they settle

Before the first end-to-end test run the whole capture path was reviewed by two
models working independently. Ten of their findings held up against the code;
two did not. The defects are fixed, but the rules underneath them are worth
recording, because each is the kind of thing that gets reintroduced.

**A lock-free FIFO has exactly one owner for each index.** `InputMonitorSource`
made room in a full ring by advancing the *read* pointer from the capture
thread. `juce::AbstractFifo` is strictly single-producer, single-consumer, and
`finishedRead` is a non-atomic read-modify-write of the read index, so this
raced the playback thread doing the same and corrupted the ring for both — every
time monitoring backed up, which is the one condition it was written to handle.
The producer now writes only what fits, and staleness is bounded on the
consumer, which owns that index. The 120 ms backlog cap clears any pairing of
device periods Silverdaw will open, so it fires on real drift accumulation
rather than on jitter.

**Hitting a limit is not failing.** The thirty-minute cap set an `errorCode`,
and the finalise path deletes the raw file for any non-empty error code — so a
capture that ran long was destroyed by the very branch meant to end it tidily,
while the dialog promised the opposite in as many words. The cap is now carried
as `hitLengthCap` on the ready payload and reported as a notice above a take
that is kept in full. `lengthCap` is gone from the error enum entirely, so the
shape of the protocol no longer invites the mistake.

**A borrowed input must be handed back as it was found.** Latency calibration
narrows the capture tap to one channel at unity gain. Nothing restored either.
Input gain silently reverted to unity after any measurement, and worse: with the
channel count stuck at one, a subsequent stereo take at non-unity gain
dereferenced a null second gain channel inside JUCE's writer, on the audio
thread. `reapplyInputSettings` now runs on both the completion and the cancel
path, and the session re-applies its own settings when it arms.

**A take is identified by its recording id, not its session id.** A session
outlives its takes, so a failure published by a worker for an abandoned take
landed on the retry that replaced it — putting a live capture into `error`,
where Stop is refused and the only way out is closing the dialog. Both
`enterReview` and `reportFailure` now require the recording id to match as
well.

**Transitions name the states they are legal from.** `selectInput` excluded
only the rolling states, and opening a device resets the session to `idle`.
Changing the input during `finalising` — which still shows the setup pane —
therefore re-armed the dialog underneath a take that was still being written,
losing it without telling anyone. It is now permitted from `idle` and
`error` only, and the renderer treats `finalising` as locked rather than
merely as "not rolling".

**Validate the session before the side effects, not after.** Three command
handlers threw the finished take away *before* the controller checked whose
session the command was for, so a late or duplicated envelope for a replaced
session deleted the current session's take while the controller correctly
ignored the rest of the command. Both handlers now reject a stale id up front.

**An unknown error code must not cost the user the whole state.** The backend
could publish `transportFailed`, which was missing from the renderer's enum;
the strict parse then dropped the entire state snapshot, leaving the dialog
frozen on the last state it understood — showing `recording` for a take that
had never started. The code has been added, and the field now degrades to the
generic message instead of rejecting its message. A state the renderer cannot
fully name is far more useful than no state at all.

**Software monitoring is refused when the two devices disagree on rate.** The
monitor hands captured frames to the output callback one for one and has no
resampler, so a 44.1 kHz input against a 48 kHz output would be heard sharp
through a ring that starves continuously. Rather than resample on the audio
thread for a path nothing is recorded through, the control is disabled and says
why. Capture itself is unaffected: the take is written at its own rate and the
library resamples it like any other file.

**Two findings did not survive checking**, and are recorded so they are not
re-raised. Indexing an empty `juce::StringArray` is bounds-checked and returns
an empty string, which the existing guard already catches. The
`ClockRateEstimator` race is real only across its 4096-point compaction; the
ordinary path is correctly published with release/acquire.

**One risk is accepted rather than fixed.** Entering review takes two envelopes,
`RECORD_RECORDING_READY` and a state change, and there is no snapshot command
to recover from losing one. The bridge is loopback TCP and does not drop or
reorder, so the only realistic way to lose one was renderer-side schema
rejection — which the tolerant parse above removes. A resync command is worth
having if recording ever gains a second surface, but inventing one for a
hazard the transport does not exhibit is not.

## Amendment Twenty-Four: a stereo take can be separated into its two channels

A hardware mixer is a common way into a single computer, and a two-channel one
feeds two different sources — a vocal and a guitar, two turntables, two
performers — down the left and right of one stereo input. Silverdaw captured
that as it arrived: a single stereo take with a different performance on each
side, which is unmixable, because gain, panning, warping and effects all belong
to a clip and there is only one clip.

**Split Channels, offered in review for a stereo take, keeps the two sides as
two separate recordings.** Each becomes a library item of its own, and on the
timeline the second always takes a track of its own rather than the one the
first landed on — the entire reason for the split is that the two sources end up
apart. Both go down at the same position, because they were performed together;
they stay aligned by construction, not by the user nudging them.

**The split happens at commit, not at review, which is where it differs from
Save as Stereo (Amendment Nine).** That option rewrites the take, so the
audition plays the file that will be kept. This one cannot: the review has one
preview voice and one file, and there is no honest way to audition two clips
through it. That turns out to be the right answer anyway. The review question is
whether the take is any good, and the two sources were performed together
against the same backing, so hearing them together *is* hearing the take.
Splitting is a decision about where the material goes — like library-versus-
timeline — not about what the take is. Doing it eagerly would also write two
extra files every time the box was ticked, real I/O on a long take, thrown away
the moment the user changed their mind.

**Building the pair is all or nothing.** A commit that wrote one half, failed on
the second and placed it anyway would be worse than refusing: the user would
have half a recording on the timeline and no obvious sign the other half was
missing. Anything that fails deletes every file it created and reports the
commit as failed, leaving the take intact in review to try again.

**The original stereo file is not kept.** What the user asked for is the pair
that came out of it, and leaving the mixed-together version in the project
folder is clutter that no library item points at. It is released from the
preview voice before it is deleted, because Windows will not remove a file with
an open handle.

**Each as Stereo, beside the split, puts each half back across both channels of
its own file.** It sits alongside rather than appearing when the split is
ticked, because a control that materialises on a tick resizes the pane under
the pointer; it is disabled until the split is on. The reasoning is Amendment
Nine's: it is about what the file *is* for downstream tooling, not what it
sounds like. It applies only under a split, and a mono take duplicated to
stereo is never offered a split — both of its sides are the same recording, so
separating them would quietly double the material.