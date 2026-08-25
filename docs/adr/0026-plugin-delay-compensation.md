# ADR 0026 — Plugin delay compensation by uniform per-track alignment

- **Date:** 2026-08-25 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

This ADR supersedes ADR 0025's deferral of plugin delay compensation.

## Context

ADR 0025 shipped VST3 inserts with latency **reported but not compensated**:
`plugins::PluginChain::getLatencySamples()` sums each slot's
`juce::AudioPluginInstance::getLatencySamples()`, and nothing acts on the
result. A plugin that reports latency — a linear-phase EQ, a lookahead
limiter, an oversampling saturator, a partitioned convolution reverb — shifts
its whole track late against every other track, in playback and in export
alike. That ADR deferred the fix on the grounds that per-track compensation
touches clip scheduling, automation sampling, metering, and the mixdown's
sample-accurate parity guarantee, and so deserves its own decision. This is
that decision.

Two facts about the current engine shape the options.

`AudioEnginePlaybackState::Track::latencySamples` already exists, defaults to
zero, and is **never assigned**. Its only reader is
`AudioEngine::trackSeekSecondsFor`, which subtracts it from the master position
when placing a track's `juce::AudioTransportSource`. Every seek, start, clip
edit, and audibility-restore path already routes through that function, so the
engine carries a complete but dormant *read-ahead* hook: pull a latent track's
source early so the plugin's own delay lands it back on time.

Inserts sit **mid-chain**. `TrackChain::process` runs Tone, Leveler,
Saturation, Bit Crusher, and Punch, then the inserts, then track level — and
`BusGraph::TrackRuntime::renderClips` runs `BeatRepeatProcessor` before the
chain and takes the meter peaks after it. Anything that moves the source
relative to the timeline therefore lands correctly on the parameters
downstream of the inserts and incorrectly on those upstream of them.

## Decision

Compensate by delaying every track to a **common alignment**, rather than by
moving any track's source against the timeline.

Let `L(t)` be track `t`'s published chain latency in samples, and `Lmax` the
largest such value across rendered tracks.

- Each track's own output is delayed by `Lmax - L(t)` by a delay line applied
  immediately after `TrackChain::process` inside `renderClips` — upstream of
  the meter peaks and of the reverb and delay send taps, so every tap sees the
  same aligned signal.
- Every track therefore leaves the graph exactly `Lmax` late, **uniformly**,
  with its clip scheduling, automation sampling, and beat repeat untouched.
- `Lmax` is recomputed on the message thread whenever a chain is published
  (add, remove, move, bypass, restore), under the existing `BusGraph` lock and
  the publish-then-barrier contract ADR 0025 already prescribes.
- `Lmax` joins device latency in the single place the reported playhead is
  already corrected: the `getOutputLatencyMs()` term in `PlayheadEmitter`.
- The mixdown trims `Lmax` samples from the head of the render and runs the
  graph `Lmax` samples past the end, restoring the sample-accurate parity
  ADR 0022 requires.
- `Lmax` is bounded at one second. A plugin reporting more is treated as
  misreporting and compensated to the bound.
- Delay lines are sized and cleared in `prepareToPlay`, and flushed wherever
  `TrackChain::reset()` is already called on stop and seek.
- **Compensation must not add start latency.** Starting playback primes the
  pipeline: `Lmax` samples of content from the play position are pushed
  through every chain and discarded before the master gate opens, so the first
  audible sample is the one at the play position rather than `Lmax` of
  silence. `AudioEngine::play` already runs
  `primeTracksForPlayback(kPlayPrimeBudgetMs)` on the message thread with the
  gate closed; priming the plugin pipeline is the same pass, advancing the
  master transport per block so automation and the plugin play head stay in
  step with the audio being pushed. Seeking while playing keeps the gate open,
  so it cannot be primed the same way — it flushes instead and refills inside
  the fade the seek already performs.

## Why

- **Uniform lateness is what makes this cheap.** Because own latency plus added
  delay equals `Lmax` for every track, nothing inside a track moves relative to
  anything else in it. Automation, beat repeat, and clip scheduling keep
  reading the master timeline exactly as they do today, which is precisely the
  breadth of change ADR 0025 was unwilling to take on blind.
- **The residual is a shape the engine already handles.** A whole mix arriving
  a constant number of samples late is what output-device latency does, and the
  playhead is already corrected for it in one place. Compensation adds a term
  to an existing correction rather than a new concept.
- **One routing for playback and mixdown.** Applying the same alignment in both
  keeps ADR 0022's guarantee that what a user hears is what they export.
- **Bounding it protects the project from a bad plugin.** Latency is
  self-reported by code we do not own; an unbounded value would silently
  desync the mix.

## Consequences and interactions

- **Nothing changes at all until a latent plugin is loaded.** `Lmax` is zero
  for a project whose plugins report no latency — which is most of them — so
  every path is bit-for-bit what it is today, including start responsiveness.
  The cost is paid only by the projects that cause it.
- **Start stays responsive; a seek costs the alignment once.** Priming moves
  the cost of starting playback from a gap in the output to message-thread CPU
  inside the existing play budget, so the downbeat still lands on time. The
  trade-off is that priming calls plugin `processBlock` off the audio thread
  with the gate closed — safe, because nothing else is pulling the graph, but
  a new call context for third-party code. A seek made *during* playback keeps
  the gate open and so cannot be primed; it flushes the delay lines and refills
  them, costing up to `Lmax` of silence inside the fade the seek already
  performs.
- **The loop wrap needs no priming.** It does not flush the delay lines, so the
  pipeline is still full at the seam and the wrap costs nothing.

- **Preview and the Scratch Editor are unaffected.** `TrackChain::setInserts`
  is called only from `BusGraphTrackFx.cpp`, so inserts attach to timeline
  `TrackRuntime`s and nothing else. Live scratch monitoring and clip preview
  therefore stay outside the compensated path and keep today's latency feel.
  The corollary is a rule: any source mixed against compensated tracks must
  take the same `Lmax` delay, or it lands `Lmax` early.
- **The timeline loop already survives it.** `wrapTimelineLoopIfDue` polls the
  engine's *uncompensated* position and wraps via
  `setPositionMsNow(..., resetEffects = false)`. Delay lines must therefore be
  flushed only on the `resetEffects` path; left alone across a wrap they carry
  the seam through exactly as reverb and delay tails already do under ADR 0023.
  Flushing them on every wrap would punch an `Lmax`-sized hole in the loop.
- **A change to `Lmax` mid-playback moves every track at once.** Adding or
  bypassing a latent plugin during playback re-times the whole graph, so the
  new delay has to be taken at a block boundary with a short ramp rather than
  applied instantly.
- **Cost is negligible.** At the one-second bound and 44.1 kHz, a stereo delay
  line is about 350 KB per track, and the work is a copy.

## Rejected alternatives

- **Read-ahead: pull latent tracks' sources early via the dormant
  `Track::latencySamples` hook.** By far the cheapest — the field, the reader,
  and every call site already exist, and it adds no output latency at all. It
  fails on insert position: the source arrives `L` samples early, so
  everything *upstream* of the inserts (Tone, Leveler, Saturation, Bit
  Crusher, Punch, and `BeatRepeatProcessor`) is applied `L` samples early to
  the content it lands on, while everything downstream (level, pan, sends,
  metering) stays correct. Fixing that needs a per-parameter split of
  `TrackAutomationSnapshot` into pre-insert and post-insert timebases, which is
  more intricate than the delay lines it was meant to avoid. It also cannot
  pre-roll the first `L` samples at the start of the timeline, and cannot
  absorb a plugin changing its latency at runtime without an audible re-seek.
  The hook has been deleted with this ADR, as a dormant mechanism that looks
  like compensation but is not.
- **Compensate only on export, leaving playback uncompensated.** Cheaper, and
  the export is the artefact that lasts. Rejected because it makes what the
  user hears differ from what they get, which is the export drift ADR 0022
  exists to prevent.
- **Leave it uncompensated and surface the reported latency in the plugin
  row.** No timing risk, and it turns a silent defect into a visible one. It
  makes the user responsible for working around the engine, which ADR 0011
  does not permit for something the engine can know on its own. Worth doing as
  an interim had this ADR not been accepted.
- **Delay only the tracks without plugins.** Equivalent to this decision when
  exactly one track is latent, and wrong as soon as two tracks carry different
  latencies, because it has no common target to align to.
- **Ask plugins to report zero latency, or refuse plugins that report any.**
  Latency is intrinsic to the algorithms that need it; refusing them would
  exclude most of the plugins worth hosting.
