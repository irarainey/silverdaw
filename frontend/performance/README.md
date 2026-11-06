# Performance benchmarks

The current implementation includes C1, R1, R2 and S1 below. Their stage-local
results must not be added together; the
[combined reference screen](#combined-reference-screen) measures all four
together against preserved M1. Neither establishes release acceptance.
The [maintenance status](../../docs/development-plan.md#performance-maintenance-unreleased)
lists completed work and remaining measurements.

Opt-in packaged-build measurements, separate from ordinary correctness tests.
Requires Windows and Node 24. This uses the existing Playwright Electron driver
and deterministic WAV generator; it does not build, install or publish an app.

## Generate projects

Run commands from `frontend`. Generated files belong in ignored `.cache`, not
in the frozen released-project fixture.

```powershell
pnpm perf:generate --output .cache\performance\corpus-diverse-v2 --case large --case stress --case extreme --case chopped --case longform --case smoke
node performance\cli.ts list
```

| Case                                | Tracks | Clips | Maximum simultaneous clips | Unique audio files |
| ----------------------------------- | -----: | ----: | -------------------------: | -----------------: |
| `large` (default)                   |     16 |   128 |                         16 |                 16 |
| `stress`                            |     32 |   512 |                         32 |                 16 |
| `extreme`                           |     64 |  1024 |                         64 |                 16 |
| `chopped`                           |     24 |  2048 |                         24 |                 16 |
| `longform`                          |      8 |    32 |                          8 |                  4 |
| `smoke` (harness verification only) |      8 |    32 |                          2 |                  2 |

The primary cases use the deterministic `varied-v1` arrangement. Each track has
eight (`large`) or sixteen (`stress`/`extreme`) clips referencing different
sources within that track. Clips range from 125 ms to 8 seconds, with some
trimmed source windows and short gaps. Every track starts at zero and progresses
independently, producing real 16/32/64-clip overlap, not serialised layers.

The varied 16-source palette spans 55-1,760 Hz, six file durations from 250 ms to
8 seconds, varied second harmonics and amplitude modulation, and 10 ms edge
fades. Three quarters of tracks have moderate gain, pan, bass and treble
settings; the others remain dry. Selected tracks carry changing gain, pan or
bass automation in native units, with visible 100 px automation lanes.

`chopped` fills all 24 tracks continuously for ten minutes. It combines
1,568 adjacent beat subdivisions (125/250/500/1,000 ms at 120 BPM) with
480 longer sections. Consecutive slices of the same source preserve contiguous
source windows, rather than restarting the sound at every cut. Edit clusters
are staggered through each minute. Every track has 85 or 86 clips; 24 clips
overlap throughout. Its files contain 8-second phrases and 64-second beds.

`longform` fills all eight tracks for ten minutes with 90-, 150- and 180-second
clips from four three-minute mono files. This is a long-take/waveform workload
for podcast-style editing, not a speech-quality test. Both ten-minute recipes
persist a ten-minute project boundary, not just distant clips beyond the
default length. They include the same processing and automation variations.

The earlier corpora and measurements are preserved, not selected by default.
The historical case IDs do not represent supported-capacity claims. Each
project contains populated tracks, unique clip IDs and portable relative media
references. The unchanged smoke case uses two-second clips in successive
groups of its stated voice count. Playback is not automated in this phase.

Additional recipes isolate track count (`tracks-8/32/64`, 256 clips),
clip count (`clips-64/128/256`, 16 tracks), simultaneous voices
(`voices-1/2/8`, 16 tracks and 256 clips), visible density
(`view-sparse`, `view-dense`) and unique sources (`media-1/8`).
Generate them with repeated `--case` arguments. Dense-view clips are 125 ms
rather than 2 seconds, keeping counts and maximum overlap fixed. These
independent controls remain uniform and dry, unlike the primary varied cases.

Source audio is synthetic, non-silent, 48 kHz PCM: mono for long-form, stereo
otherwise. Varied sources retain visible waveform amplitudes; master gain,
not the source waveforms, is reduced by the voice count for quiet playback.
Uniform controls retain their original source-level normalisation.
IDs, audio, metadata and timestamps are fixed.
`manifest.json` hashes every input and fingerprints the recipe. A modified
input fails verification. Generation refuses existing output directories.
Changing recipes requires a new corpus; never compare different fingerprints.

The `.silverdaw` files can also be opened manually. Use a copy: the application
writes project metadata and view state. The runner always copies only the
hash-covered inputs and leaves the master corpus unchanged.

## Run a packaged build

Keep the current portable ZIP unchanged as the baseline. Extract it into a new
directory without rebuilding; do not use the unsigned Store-pass
`dist\win-unpacked` byproduct by accident. For example, from the repository root:

```powershell
Expand-Archive -LiteralPath dist\Silverdaw-1.10.0.zip -DestinationPath .cache\performance\baseline-1.10.0
Set-Location frontend
```

Close other app instances and competing builds. Keep monitor/DPI/refresh rate,
GPU driver, Windows power settings and audio device/rate/buffer settings fixed.
Describe those settings in `--environment`; use the identical label for A/B.
The runner records CPU, OS, machine fingerprint, memory, GPU, actual viewport,
runtime versions and hashes of the complete packaged directory.

```powershell
pnpm perf:run --app ..\.cache\performance\baseline-1.10.0\Silverdaw.exe --corpus .cache\performance\corpus-diverse-v2 --case large --environment "local-fixed-settings" --output .cache\performance\baseline-large.json
```

The default is five serial repetitions with a fresh profile and project copy
each time. Every repetition opens the real project, waits for its shell and a
live WebGL canvas, warms up for 60 animation frames, measures idle frames,
scrolls through the track stack, zooms, and uses Save As through the native
writer into a fresh named project folder, resolved by the application's
`projectFolderPath` helper. Its native save picker is stubbed with that explicit
path, as in the E2E tier; no OS dialog requires human input.
Saved track/clip/library counts must agree with the manifest. Clip ownership,
source references, timing, processing, automation curves and lane views must
survive the native read/save roundtrip. Scroll distance includes expanded
automation rows.

The current workload version is 3. Earlier save checks timed out in some
64-track runs; one explicit Save As diagnostic had actually saved successfully
inside the application's named project folder while the harness watched the
un-normalised path. Those failed reports are preserved, not reclassified as
accepted samples. They do not prove a load failure or diagnose an application
defect. Comparisons reject different workload versions.

The original frozen package has
[recorded five-trial results](#recorded-diverse-baseline)
for all six generated projects. Four cases qualify as its timing baselines;
`extreme` and `chopped` have recorded failure baselines, not reliable timing
baselines. Do not accept projects on shell/canvas readiness alone or treat
missing waveforms as an established GPU-rendering defect.
Later local build screens are recorded separately below; they do not replace
those original results.

This is **not** a cold-disk measurement: OS caches and home-based model caches
are uncontrolled. Sixty warm-up frames do not prove all waveforms have loaded.
`openToShellPaintMs` ends after the project shell/canvas appears and two RAFs;
it is not complete waveform/backend readiness or a guaranteed GPU presentation.
Frame intervals are RAF cadence, not isolated renderer CPU/render durations.
Scroll/zoom timings include input delivery and the fixed pauses between wheels.

Resource sampling uses one owned PowerShell helper at one-second intervals.
It records the Electron processes present at startup and the owned backend:
private bytes, working set, handles and cumulative CPU time. Sampling adds
overhead; keep it identical between builds. Peak memory is the **sampled**
maximum, not an instantaneous high-water mark. Bridge counters contain only
received frames observed by Playwright, not complete wire/queue diagnostics.

Default guards are 4,096 MiB total sampled private memory and 180 seconds per
repetition after launch. `--max-private-mib` and `--timeout-ms` can be raised
explicitly for a machine with headroom. Sampled limits are not hard OS memory
caps and cannot prevent a faster allocation spike. Stops and failures produce
failed reports, not partial success. Launch also has its own timeout.
Do not jump straight to `extreme` on a memory-constrained machine.

For a quick harness check, explicitly select `--case smoke --runs 1 --frames 30
--steps 24`. This is not a capacity measurement. Results refuse overwriting an
existing JSON file. Failed runs retain their temporary evidence; successful
runs remove it where Windows permits. Cleanup failures are reported explicitly
in stderr and `cleanupWarnings`, never retried indefinitely. Logs/diagnostics
under the user's Silverdaw home directory remain shared, as in the E2E harness.

## Compare

Run the same command against a separate candidate packaged directory, changing
only `--app` and `--output`. Do not create distribution assets implicitly.
Interleave baseline/candidate batches to reduce drift.

```powershell
pnpm perf:compare .cache\performance\baseline-large.json .cache\performance\candidate-large.json --output .cache\performance\comparison-large.json
```

Comparison rejects failed/empty reports and mismatched fixture fingerprints,
environment or workload settings. It reports per-run medians/ranges and
percentage deltas; negative means lower, not automatically a meaningful win.
CPU deltas cover the sampled window, not complete process lifetime.
Frame percentiles use individual intervals within each run; tiny smoke runs
have too few frames for useful tail estimates. Five load samples support a
median/range, not a credible load-time p99. Establish noise before setting
relative regression thresholds.

This first phase does **not** measure play/seek latency, actual audio dropouts,
callback p99, waveform completion, edit/undo latency, export parity, internal
snapshot/graph timings or complete bridge queues. Add those workloads and
appropriate instrumentation next; existing audio interval maxima must never
be presented as callback p99. Functional/audio correctness gates remain
separate prerequisites for accepting optimisations.

## Native project phase diagnostics

The development backend supports opt-in project-operation traces, separate
from the packaged timing workload. Build the development backend first, then
launch the app with an absolute trace path whose parent directory exists:

```powershell
New-Item -ItemType Directory -Force .cache\performance\phase-traces | Out-Null
$env:SILVERDAW_PERFORMANCE_TRACE_FILE = Join-Path $PWD '.cache\performance\phase-traces\operations.jsonl'
pnpm dev
Remove-Item Env:\SILVERDAW_PERFORMANCE_TRACE_FILE
```

The setting is read once per backend process; restart after changing it.
Ordinary `perf:run` explicitly strips this setting so diagnostic file writes
cannot silently enter a timing comparison.

JSONL records correlate each load, recovery, save, Save As, autosave or
view-state save with an operation ID and a monotonic message-queue wait.
Phase checkpoints are flushed before expensive work, retaining the last
entered phase if the process is terminated. A `return` event means the handler
returned, not that the operation succeeded; check its normal acknowledgement
and saved contents independently.

Records include `processId` and UTC-epoch `timestampUnixMs` for correlation
with watchdog logs and backend generations. Between clip constructions, at
most one `progress` record per second retains completed span aggregates and
the active `phaseElapsedMs`. This is not a heartbeat, call-stack sample or
guarantee of progress during a blocked individual call.

Timings distinguish project loading, engine reconstruction, playback priming,
snapshot construction/encoding/sending, plugin-state capture, clean-state
capture, tree/path/JSON conversion, file writing and atomic replacement.
Per-clip construction/preparation, pending track FX during attachment,
latency recomputation and graph snapshot build/publication accumulate counts,
total wall time and maximum duration without per-clip file writes. Nested
timings are inclusive: do not sum them as disjoint phases. `projectStateBytes`
counts encoded snapshot bytes, not total wire traffic or delivery completion.

Tracing is disabled by default, records no payloads or paths, and does not
instrument the audio callback or change watchdog behaviour. Record writes
are excluded from individual phase timers but included in operation elapsed
time. Establish its on/off overhead in separate diagnostic runs before
interpreting small differences. These traces do not add waveform completion,
renderer CPU/GPU, playback/dropout or callback-percentile measurements to
workload version 3.

### Initial native attribution screen

Unpackaged Release probes loaded and saved all six fixtures with tracing both
off and on, checking native saved contents and complete diagnostic records.
These single on/off pairs validate the hooks, not statistical overhead.
The traced heavy loads attributed the following wall time:

| Case | Load handler | Source preparation | Graph snapshot build + publication | Save As handler |
| ---- | -----------: | -----------------: | ---------------------------------: | --------------: |
| `extreme` | 6.00 s | 5.27 s | 11.53 ms | 94.83 ms |
| `chopped` | 12.11 s | 10.51 s | 18.98 ms | 170.74 ms |

Source preparation ran once per clip. In this pre-C1 baseline, JUCE's buffering
preparation loop slept for 5 ms on every newly prepared buffer, consistent with the
observed serial warmup cost. This makes preparation the first measured native
opening candidate, not graph publication. Read-ahead readiness and publication
lifetimes had not been changed at that checkpoint. C1 below subsequently
replaced the unconditional sleep while retaining the deep-prefill barrier.

These probes have no Electron renderer, waveform-request burst or frontend
watchdog. They do not establish the cause of the earlier packaged failures or
qualify those cases for timing comparisons. Evidence is retained in
`.cache\performance\native-phase-probe-2026-11-05T13-45-44-796Z` and
`.cache\performance\native-phase-probe-2026-11-05T13-45-52-302Z`.

## Identical-build measurement noise

On 2026-11-05, the same frozen package completed 80 serial A/A trials: ten
pairs for each historically qualified case, four cases round-robin per arm,
with alternating AB/BA pair order. All 80 trials passed save-content, backend
PID, lifecycle and actual-waveform qualification. The package and all six
corpus fingerprints were verified unchanged before and after collection.
`extreme` and `chopped` were excluded from timing-noise estimation because
their original baselines failed; their reliability is not requalified here.

| Case | Qualified | Arm A median open | Arm B median open | Median paired change | Descriptive 95% paired interval |
| ---- | --------: | ----------------: | ----------------: | -------------------: | -----------------------------: |
| `smoke` | 20/20 | 2.49 s | 3.03 s | +0.17% | -5.15% to +10.29% |
| `large` | 20/20 | 3.07 s | 3.00 s | +3.06% | -4.04% to +14.47% |
| `stress` | 20/20 | 5.19 s | 5.49 s | +0.37% | -2.74% to +10.77% |
| `longform` | 20/20 | 2.45 s | 2.57 s | -0.99% | -7.23% to +3.19% |

Paired changes use the median log(B/A); intervals use 10,000 deterministic
bootstrap resamples of the ten pairs. These are descriptive estimates
conditional on this session, not universal regression thresholds or
rare-failure guarantees. Ratios of separate arm medians can differ sharply
from paired estimates: the unchanged `smoke` binary appears 21.7% slower by
that unpaired measure. Small apparent gains therefore need matched,
interleaved confirmation, not a blanket 5% acceptance threshold.

Raw reports, qualifications, arm aggregates, analysis and hashed collector
sources are retained under
`.cache\performance\reference-noise-v3-2026-11-05T13-13-26-514Z`. The existing
six-case baseline below remains unchanged. This measures noise, not an
optimisation.

## Bridge-fixed packaged reference (B1)

On 2026-11-05, a separate copy of the frozen package received the archived
pre-diagnostic, bridge-fixed Release backend. Its only changed packaged file
is `resources\backend\SilverdawBackend.exe`; every other file hash matches the
frozen package. The archived engine predates phase tracing. Binary provenance
is retained, but independently reproduced source-build equivalence is not
claimed.

Exactly five serial round-robin trials per case used the same version 3
workload, environment checks and qualification as the original baseline.
No failed trials were discarded or replaced.

| Case | Frozen baseline qualified | B1 screen qualified |
| ---- | ------------------------: | ------------------: |
| `smoke` | 5/5 | 5/5 |
| `large` | 5/5 | 5/5 |
| `stress` | 5/5 | 5/5 |
| `extreme` | 2/5 | 5/5 |
| `chopped` | 1/5 | 3/5 |
| `longform` | 5/5 | 5/5 |

All 28 qualified trials saved correct contents and had real waveform data
on every clip, with an unchanged backend PID and no renderer/lifecycle errors.
Both failures were `chopped` project opens: the unchanged watchdog requested
a restart after `no PONG after 3 probes`. No Save As waits failed in this
screen. This does not establish that the earlier intermittent save failures
are eliminated.

The screen **failed overall**, so the predefined 30-trial heavy-case
confirmation was not started. Five clean `extreme` trials are only a screen,
not strong reliability evidence. `chopped` remains ineligible for timing
comparison; its successful subset must not support improvement claims.
Historical baseline counts are context, not an interleaved speed comparison.
These untraced packaged failures do not yet establish where the native
message thread stalled.

The B1 package is retained at
`..\.cache\performance\reference-b1-2026-11-05T15-03-52-332Z` relative to
`frontend`. Its complete package fingerprint is:

```text
1d71150814a1681322bf2fd778f7e52cc601bcd66cc53bb5a0b891cd7b98d3e2
```

Raw reports, screenshots, failed-trial evidence paths, aggregate reports,
verification results, hashed collector sources and before/after package
inventories are retained under
`.cache\performance\bridge-reference-2026-11-05T15-03-52-332Z`, also relative
to `frontend`. The frozen package and all six fixture fingerprints were
verified unchanged after collection.

## Packaged phase attribution (D1)

A separate packaged diagnostic copy uses the same frozen frontend and runtime
files with only its backend replaced by the validated phase-tracing build.
The watchdog, source readiness and graph publication behaviour are unchanged.
This is diagnostic evidence, not a new qualified timing baseline.

The initial fixed schedule comprised one tracing-off/on pair each for
`smoke` and `extreme`, followed by five `chopped` pairs with alternating pair
order. All 14 trials passed content, PID, lifecycle and waveform checks.
Since no failure reproduced, a separate fixed follow-up compared five
alternating `chopped` pairs using the existing B1 untraced and D1 traced:

| Experiment | Backend / tracing | Qualified trials |
| ---------- | ----------------- | ---------------: |
| Initial controls | D1 `smoke`, off / on | 1/1 each |
| Initial controls | D1 `extreme`, off / on | 1/1 each |
| Initial chopped | D1, off / on | 5/5 each |
| Follow-up chopped | B1, off | 3/5 |
| Follow-up chopped | D1, on | 5/5 |

Both follow-up B1 failures again restarted during project open after
`no PONG after 3 probes`. No trace-capable D1 failure reproduced, so no
failed B1 operation can yet be assigned a native phase. The follow-up
confounds binary/build and instrumentation differences; it does not prove
tracing fixed the problem or establish that D1 is reliably clean.

Across the ten successful traced `chopped` loads, the native handler took
approximately 12.4-12.7 s, including 10.4-10.5 s in 2,048 serial source
preparations. Graph snapshot build and publication together took about
22-26 ms. Preparation is therefore a measured opening hotspot in D1, but
these successful traces do not prove the cause of the B1 watchdog failures.
Each retained about twelve bounded progress records; no call-stack sampling,
watchdog relaxation or buffer-warmup optimisation was introduced.

The D1 package fingerprint is:

```text
0aa605ce2d7dbabd9f9818ee824d7864db3c52bab1a249360ac907cb17d684f9
```

Evidence directories, relative to `frontend`, retain the immutable collector
versions, raw reports, traces, analyses, screenshots and native executable:

```text
.cache\performance\packaged-phases-2026-11-05T15-28-33-638Z
.cache\performance\packaged-phases-b1-pairs-2026-11-05T15-37-52-175Z
```

The original frozen package, B1 package and all six fixture fingerprints
remain unchanged. Diagnostic environment labels deliberately differ from
ordinary benchmark labels; do not treat these runs as timing comparisons.

## Matched clean-build diagnostic screen (M0/M1)

Fresh, isolated Ninja Release builds establish an explicitly recorded
source/build comparison. M0 uses committed backend source from `393c2b2d`;
M1 starts from that snapshot and overlays only the twelve native diagnostic
files. Both use the same MSVC compiler, disconnected cached dependency sources
and configuration. All 305 common translation units have matching compiler
commands after normalising source/build roots and directory separators; only
the trace implementation and its tests add translation units.

The runtime precheck caught a different hash for the local untracked LAME
executable. Both builds were aligned to the existing frozen executable before
measurement; the original build inputs and validation evidence remain archived.
The aligned native suites passed 518/518 for M0 and 522/522 for M1. Runtime
imports match, and all 29 runtime dependency/profile files checked per build
match the frozen package. Each new package changes only the backend executable.
Source snapshots and shared cached sources were verified unchanged.

The predeclared 21-trial schedule used three arms: M0 without tracing, M1
without tracing, and the same M1 binary with tracing enabled. Each arm ran one
`smoke` and one `extreme` control, followed by five `chopped` trials in rotating
arm order. No failures were discarded, replaced or retried.

| Case | M0 | M1, tracing off | M1, tracing on |
| ---- | -: | --------------: | -------------: |
| `smoke` | 1/1 | 1/1 | 1/1 |
| `extreme` | 1/1 | 1/1 | 1/1 |
| `chopped` | 5/5 | 4/5 | 5/5 |

The screen **failed overall**. `chopped-4-diagnostic-off` restarted during
project open at `2026-11-05T16:17:04.092Z` after
`no PONG after 3 probes`. The same watchdog symptom is therefore not confined
to archived B1. This does not establish a shared root cause or prove that
enabling tracing prevents it. Since tracing was disabled in the failed
attempt, no failed native operation was captured for phase attribution.

All twenty qualified trials saved correct contents and had real waveform data
on every clip, with an unchanged backend PID and no renderer/lifecycle errors.
The five successful traced `chopped` loads took approximately 12.6-12.8 s in
the native handler, including 10.4-10.5 s preparing 2,048 sources; graph
snapshot build/publication together took 21-27 ms. This confirms the measured
opening hotspot, not the failed load's phase or cause.

These are bounded diagnostic screens, not qualified timing baselines or proof
of rare-failure reliability. The watchdog, source readiness, graph lifetimes
and version 3 workload remain unchanged; no optimisation was introduced.

| Package | Complete fingerprint |
| ------- | -------------------- |
| M0 | `c15d2065c65b0306e7aeb6548d86b000fea611c48b14c8e6f3090498a7c2e072` |
| M1 | `c963599405f4354422a5a705c70c6f0eadca333613429e656553d4eb9114beab` |

Source archives, input inventories, configuration, compiler-command checks,
native validation and package identities are retained under the repository-root
directory `.cache\performance\matched-20261105T155334`. Raw reports, traces,
screenshots, failure evidence, analysis and the exact collector are retained
under the following directory relative to `frontend`:

```text
.cache\performance\matched-phases-2026-11-05T16-07-04-260Z
```

The frozen package, B1, D1 and all six fixture fingerprints were verified
unchanged. All recorded native backend PIDs were closed after collection.

## Event-driven source preparation (C1)

The first opening optimisation replaces JUCE's fixed five-millisecond
preparation sleep with a bounded wait on its existing buffer-ready event.
The original deep-prefill condition is unchanged: sources still return from
preparation only after the required prefix is ready. This does not disable
prefill, parallelise graph mutations or relax the watchdog.

A Windows-only, idempotent CMake patch rejects changed upstream preparation
code rather than applying blindly. The Release experiment uses a private JUCE
copy; all original matched dependency inputs remain unchanged. The only JUCE
source change is that wait. All 307 common translation-unit compiler commands
match M1 after normalising directory/object-output paths. The 29 runtime/profile
files and native runtime imports still match the control.

Debug and Release each passed all 523 native tests. A slow-producer regression
checks the complete cold prefix immediately after preparation, without an
additional readiness wait, and repeats after a seek/sample-rate reprepare.
Existing first-block, seek, playback and mixdown regressions remain intact.

The fixed screen used five alternating control/candidate pairs per case in
serial round-robin order: 60 ordinary version 3 trials, with tracing disabled
in both arms. M1 is the control; C1 changes only the packaged backend. Failed
attempts were neither discarded nor replaced.

| Case | M1 qualified | C1 qualified | Median paired shell-open change |
| ---- | -----------: | -----------: | ------------------------------: |
| `smoke` | 5/5 | 5/5 | +0.8% |
| `large` | 4/5 | 5/5 | excluded |
| `stress` | 5/5 | 5/5 | -61.6% |
| `extreme` | 5/5 | 5/5 | -72.5% |
| `chopped` | 5/5 | 4/5 | excluded |
| `longform` | 5/5 | 5/5 | -4.8% |

For `stress`, median shell-open time fell from 4.62 s to 1.66 s; for
`extreme`, from 7.64 s to 2.16 s. Their descriptive paired bootstrap intervals
were -64.6% to -49.3% and -72.8% to -63.5%, respectively. These improvements
are substantially larger than the previously measured A/A noise. The smaller
cases do not establish similarly clear gains. Shell-open still means shell
paint plus two RAFs, not complete waveform/backend readiness or GPU presentation.

The screen **failed overall**, with 29/30 qualified in each arm. The first
`large` control exceeded the 60-second guard during warmup frames, without a
native lifecycle failure. The fifth `chopped` candidate exceeded the unchanged
2,048 MiB private-memory guard during zoom: the peak sample was 2,072.3 MiB,
including about 333.0 MiB in the backend and 1,739.3 MiB outside it. This
requires follow-up; it is not evidence that the extra memory is harmless or
necessarily caused by this change. Neither case supports a timing comparison,
and C1 is **not fully qualified for the corpus**.

All 58 qualified attempts saved correct contents and had actual waveform data
on every clip, with stable backend PIDs and no renderer/lifecycle errors.
No watchdog failure occurred in this screen, but the control also stayed clear:
this does not prove that the historical watchdog issue is fixed. No rendering,
memory-budget or persistence optimisation is claimed.

A separate traced `chopped` probe per arm passed qualification. Native load
time was 12.11 s for M1 and 1.21 s for C1; source preparation accounted for
10.31 s and 0.244 s, respectively, across 2,048 preparations. These are single
diagnostic observations explaining the mechanism, not a replacement for the
excluded ordinary `chopped` comparison.

C1's complete package fingerprint is:

```text
2db5b7d1b563c3b0c311597c374b8d26f89629e9649bba1a9648194306daf184
```

Source/input inventories, native gates, compiler checks and package provenance
are retained under repository-root
`.cache\performance\opening-20261105T162824`. Raw reports, failure evidence,
screenshots, analyses and exact collector versions are retained at these paths
relative to `frontend`:

```text
.cache\performance\opening-screen-2026-11-05T16-44-16-061Z
.cache\performance\opening-traces-2026-11-05T17-07-20-019Z
```

## Shared waveform cache reads (R1)

The rendering-memory phase investigated C1's chopped-project budget failure.
Two separate, fixed C1 diagnostic probes identified 2,048 independent clip
buffers retaining 496.5 MiB of waveform/LOD backing storage. This storage
survived an explicit diagnostic GC. Electron process metrics attributed the
large backing-store allocation to the renderer, not the native engine.
GPU private memory also grew during the workload; that is a separate concern,
not an established graphics-lifetime diagnosis.

R1 shares the pending IPC read for the same peaks-cache path. Each envelope
still undergoes the existing binary validation and updates its own clip.
The map entry is removed on success or failure, so this is not a persistent
file cache and a later read can observe rewritten data. Different paths never
share a read. No peak values, drawing rules, native code, readiness conditions,
watchdog settings or memory limits change.

Two fixed R1 diagnostic probes retained 98.7-104.5 MiB in waveform/LOD buffers,
with 286-294 clip buffers rather than 2,048. Sharing depends on message/I/O
scheduling: this does not promise one buffer per source. After diagnostic GC,
renderer private memory was 377.2-383.0 MiB versus C1's 761.1-778.1 MiB.
These probes use CDP heap/allocation sampling and forced GC only after the
measured workload. They are attribution evidence, not ordinary timing samples;
the application does not force GC.

R1 retains every C1 package file except `resources\app.asar`; inside the
archive only renderer outputs change. Main, preload, backend and runtime
dependencies are byte-identical. An isolated pristine control rebuild matched
all 53 renderer files after normalising generated chunk names and dependency
source-header comments only. The candidate's executable delta is exactly the
shared-read helper and call site. The stricter byte-comparison mismatch and
its evidence remain retained, rather than being described as a byte-identical
rebuild.

All 2,469 frontend unit tests passed, including regressions for shared buffers,
independent envelope validation, different files, failure recovery and later
rereads. Final focused tests, typecheck, lint and all 35 built-app E2E journeys
passed. The unchanged native engine retains C1's 523/523 Debug and Release
validation; it was not rebuilt for this renderer-only change.

The ordinary screen ran five alternating C1/R1 pairs per case, round-robin:
60 version 3 trials, no tracing, CDP profiling, forced GC or replacement trials.
All **30/30 per arm** passed the unchanged 2,048 MiB and 60-second guards,
complete waveform checks, native save-content checks and backend PID/lifecycle
checks.

| Case | C1 / R1 qualified | C1 median peak private | R1 median peak private | Median paired memory change | Median paired shell-open change |
| ---- | ----------------: | ---------------------: | ---------------------: | --------------------------: | ------------------------------: |
| `smoke` | 5/5 / 5/5 | 615.8 MiB | 615.6 MiB | 0.0% | -0.8% |
| `large` | 5/5 / 5/5 | 812.6 MiB | 793.0 MiB | -2.6% | -2.2% |
| `stress` | 5/5 / 5/5 | 999.2 MiB | 964.8 MiB | -3.2% | -1.1% |
| `extreme` | 5/5 / 5/5 | 1,232.8 MiB | 1,168.0 MiB | -5.3% | -0.1% |
| `chopped` | 5/5 / 5/5 | 1,904.7 MiB | 1,416.9 MiB | -23.5% | -19.3% |
| `longform` | 5/5 / 5/5 | 915.6 MiB | 852.0 MiB | -6.5% | -0.8% |

Paired changes are medians of log(candidate/control) ratios, not ratios of
the two unpaired medians. Chopped's descriptive paired 95% bootstrap intervals
were -26.8% to -19.0% for memory and -23.3% to -9.3% for shell-open time.
Its R1 sampled peaks ranged from 1,396.8 to 1,456.5 MiB. The native engine
remained about 333 MiB in the diagnostic probes; the improvement is renderer
headroom, not reduced audio buffering. Other opening changes are small or
noisy. Scroll/zoom RAF p95 changes were approximately +/-0.6%; no faster GPU
rendering or saving is claimed.

R1 qualifies this fixed corpus screen. Five clean trials per case do not prove
rare-failure reliability or erase the earlier C1 guard failure. Neither arm
had a watchdog restart, so the historical no-PONG cause remains unproved.
Viewport/GPU resource lifetimes and persistence remain later work.

R1's complete package fingerprint is:

```text
5c9bb8cd900bdb57d98d34c363b2164541f103df79d4bb9451f9bfcd804945ca
```

Source snapshots, compiled-output proof, validation, diagnostic analysis,
package inventories and final preservation checks are at repository-root
`.cache\performance\rendering-20261105T191528`. The reused collector's inherited
opening-phase explanatory sentence is corrected separately in
`collector-description-correction.json`; raw summaries and collectors remain
unchanged. Reports, screenshots, profiles and exact collector versions are
retained at these paths relative to `frontend`:

```text
.cache\performance\rendering-memory-2026-11-05T19-09-34-375Z
.cache\performance\rendering-r1-memory-2026-11-05T19-20-25-202Z
.cache\performance\rendering-screen-2026-11-05T19-26-27-628Z
```

The frozen package, B1, D1, M0, M1, C1 and all six fixture fingerprints remain
unchanged. Recorded experiment processes were closed. No installer,
distribution archive, installation, commit, tag or release was created.

## Explicit viewport resource lifetimes (R2)

R1's follow-up viewport probes identified transient ruler, grid, header and
clip-label nodes being detached on redraw without explicit destruction.
Pixi's default unused-resource collection can wait a minute. Sampled retained
allocations included graphics paths; ordinary JavaScript GC did not remove
the observed WebGL resource accumulation during this bounded workload.

R2 explicitly destroys frame-owned nodes while retaining the existing ordinary
graphics, beat-marker and waveform-mesh pools across redraws. Scene replacement
also releases detached pool surplus and each mesh's exclusively owned geometry
and buffers. Shared textures, including `Texture.WHITE`, and process-global
Pixi pools are not destroyed. Waveform math, draw order, hit regions, scrolling
translation, readiness and all native behaviour are unchanged.

Two fixed chopped-project probes per version used the same diagnostic WebGL
wrappers and workload. Every probe passed waveform, native-save, PID, lifecycle
and existing budget checks, with no WebGL context losses:

| Diagnostic metric after workload and diagnostic GC | R1 | R2 |
| ------------------------------------------------- | --: | --: |
| Renderer V8 heap | 102.8-103.4 MiB | 24.0 MiB |
| Net observed WebGL textures | 4,317-4,350 | 125 |
| Net observed WebGL buffers | 1,408-1,416 | 546 |
| Renderer private memory | 384.1-387.6 MiB | 266.0-266.9 MiB |
| GPU-process private memory | 565.9-590.5 MiB | 344.7-385.7 MiB |

Net counts mean observed creations minus explicit deletes, **not** actual
GPU-resident/live objects; automatic browser reclamation is not counted.
WeakSets avoid retaining measured resources. CDP profiling and wrappers
perturb execution, and forced GC occurs only after the measured workload.
These probes are attribution evidence, not ordinary timing samples.

R2 changes only renderer files inside `resources\app.asar`; main, preload,
native engine and runtime files are byte-identical to R1. A pristine control
rebuild matched all 53 renderer files after normalising generated chunk names
and dependency source-header comments only; the raw byte mismatch is retained.
Only the index module has an executable candidate delta. All 2,472 unit tests,
typecheck, lint and 36 built-app E2E journeys passed, including a new journey
that recovers the timeline context while the clip editor stays alive, redraws
both surfaces and saves the native clip.

The ordinary screen ran five alternating R1/R2 pairs per case, round-robin:
60 version 3 trials without profiling, forced GC, tracing or replacements.
Both arms qualified **30/30**, with the unchanged 2,048 MiB and 60-second
guards, complete waveforms, correct native save contents, unchanged backend
PIDs and no renderer/lifecycle errors.

| Case | R1 / R2 qualified | R1 median sampled peak private | R2 median sampled peak private | Median paired memory change |
| ---- | ----------------: | -----------------------------: | -----------------------------: | --------------------------: |
| `smoke` | 5/5 / 5/5 | 624.8 MiB | 562.6 MiB | -10.0% |
| `large` | 5/5 / 5/5 | 807.6 MiB | 618.7 MiB | -22.6% |
| `stress` | 5/5 / 5/5 | 956.2 MiB | 744.1 MiB | -22.2% |
| `extreme` | 5/5 / 5/5 | 1,151.9 MiB | 983.4 MiB | -15.6% |
| `chopped` | 5/5 / 5/5 | 1,423.1 MiB | 1,164.0 MiB | -18.1% |
| `longform` | 5/5 / 5/5 | 843.6 MiB | 604.0 MiB | -28.4% |

These are sampled combined process-private peaks, not GPU-only allocations.
Paired changes use median log(candidate/control) ratios, not ratios of
unpaired medians. Chopped's descriptive paired 95% bootstrap interval was
-21.9% to -15.2%; its R2 peaks ranged from 1,127.3 to 1,222.0 MiB.
Scroll/zoom RAF p95 changes were approximately +/-0.6%, and paired shell-open
changes were small or noisy. This qualifies lower viewport-workload memory,
not faster GPU throughput, project opening or saving.

Five clean trials per case do not establish rare-failure reliability. Neither
arm restarted, so the historical no-PONG cause remains unproved. Persistence
is the next separate phase; no persistence implementation changed here.

R2's complete package fingerprint is:

```text
b7d7872ecff86f3115b752957178e61a34febcefe1065a146bb6c46cd2eccaaf
```

Source snapshots, validation, build proof, diagnostic analysis and final
preservation checks are at repository-root
`.cache\performance\viewport-20261105T200112`. Raw reports, profiles,
screenshots and exact collectors are retained relative to `frontend`:

```text
.cache\performance\viewport-resources-2026-11-05T19-52-54-031Z
.cache\performance\viewport-resources-2026-11-05T20-06-18-930Z
.cache\performance\viewport-screen-2026-11-05T20-07-52-507Z
```

The frozen package, B1, D1, M0, M1, C1, R1 and all six fixture fingerprints
remain unchanged. Recorded experiment processes were closed. No installer,
distribution archive, installation, commit, tag or release was created.

## Post-Save As snapshot construction (S1)

Native attribution identified snapshot construction, not disk persistence, as
the dominant Save As handler phase in the 2,048-clip chopped project.
`tracksAsJson()` already holds each clip node but called the ID-based timing
getter, which rescanned the arrangement for every clip. S1 reuses that node
through the same canonical timing resolver. The public ID-based getter retains
its lookup and timing rules; the cohesive resolver lives in
`ProjectStateClipTiming.cpp`. No cache, payload, file-format or timing-rule
change was introduced.

Two fixed, separate traced chopped probes qualified with identical
path-normalised authoritative snapshots:

| Native diagnostic phase | R2 | S1 |
| ----------------------- | --: | --: |
| Entire Save As handler | 172.5 ms | 86.0 ms |
| Project snapshot construction | 128.5 ms | 36.4 ms |
| Project snapshot send | 19.9 ms | 21.3 ms |
| Actual file-save operation | 22.1 ms | 26.1 ms |

These are one traced probe per arm, not ordinary timing samples. Native spans
are nested and must not be summed with their children. Portable paths,
temporary-file writing, write-through atomic replacement, dirty/undo semantics
and save acknowledgements are unchanged. Ordinary Ctrl+S does not broadcast
this post-Save As snapshot; no faster disk write or ordinary-save claim follows.

The ordinary comparison introduced a passive Playwright WebSocket observer in
both arms. It measures Save As request observation to the matching successful
`PROJECT_SAVED` acknowledgement, and separately to subsequent clean
`PROJECT_STATE` receipt. The latter includes observer/event-delivery latency:
it is neither isolated native CPU time nor renderer paint. Both arms await
that snapshot before ending resource sampling, so these new endpoints require
this fresh comparison rather than the earlier R2 reports.

The fixed schedule completed five alternating pairs per case, round-robin:
**30/30 qualified per arm**, without tracing, profiling, forced GC or replacement
trials. All 30 pairs had equal full-snapshot hashes after normalising only the
per-trial project-directory prefix. Waveforms, saved native contents, backend
PIDs, lifecycle/renderer checks and the 2,048 MiB / 60-second guards all passed.

| Case | R2 median snapshot receipt | S1 median snapshot receipt | Median paired change | Descriptive 95% paired interval |
| ---- | -------------------------: | -------------------------: | -------------------: | -----------------------------: |
| `smoke` | 18.5 ms | 18.4 ms | +7.9% | -34.1% to +80.1% |
| `large` | 56.8 ms | 35.9 ms | -30.5% | -61.5% to -21.1% |
| `stress` | 59.9 ms | 54.9 ms | -16.3% | -47.8% to -7.4% |
| `extreme` | 106.8 ms | 91.2 ms | -22.2% | -48.9% to +39.7% |
| `chopped` | 200.4 ms | 117.6 ms | -41.9% | -56.6% to -38.3% |
| `longform` | 17.5 ms | 17.9 ms | +4.4% | +0.8% to +46.2% |

Paired changes use median log(candidate/control), not ratios of separate
medians. Intervals use 10,000 deterministic bootstrap resamples of five pairs
and remain descriptive. These new observer endpoints have no A/A noise
calibration; the earlier shell-opening noise bounds are not their thresholds.
Chopped's median paired absolute reduction was 91.7 ms. Extreme's interval
includes slower outcomes. No small-case gain is claimed: longform's median
paired absolute increase was 0.76 ms, and smoke's was 1.30 ms. Acknowledgement
timings do not establish a general file-write improvement.

Opening was variable, with some later trials taking several seconds longer
in both arms; no additional opening gain is claimed. Scroll/zoom RAF p95
medians changed by approximately +/-0.6%. No rendering-throughput or
memory-improvement claim is made. Stress's combined sampled-private median
increased from 755.3 to 813.7 MiB (+7.7%); native sampled-private peaks remained
136.8-137.3 MiB for R2 and 136.9-137.4 MiB for S1.

A separate fixed four-probe stress diagnostic, ordered R2/S1 then S1/R2,
investigated that memory observation without replacing ordinary samples.
After diagnostic GC, renderer heaps were about 19.5 MiB in both arms, with
identical net observed buffers (402) and textures (151), and no context losses.
Renderer private memory was 124.3-126.8 MiB versus 124.0 MiB; GPU private memory
was 317.1-326.2 MiB versus 337.3-340.2 MiB. Profiling perturbs execution, net
resource counts are not GPU-live bytes, and two probes per arm do not explain
the higher combined/GPU-private measurements or prove the absence of a leak.
That secondary memory caution is retained rather than classified as a gain.

S1 changes only the packaged backend executable. All 308 common translation
unit commands match C1 after source/build/JUCE-root and object-path
normalisation; the timing translation unit is the sole addition. All 29 native
runtime/profile files and imported DLLs match control. Renderer, main, preload
and Electron files are byte-identical to R2. Source verification records only
CRLF/LF differences in seven unchanged test/tool/licence files; production
source bytes and frozen build/dependency inputs match.

Debug and Release each passed **523/523** native tests, all **36** built-app E2E
journeys passed, and the extracted timing source passed formatting. Full strict
clang-tidy 22.1.8 runs cover 162 candidate and 161 control translation units.
**At the S1 checkpoint, strict lint was nonzero in both frozen arms** on the same pre-existing
`readability-redundant-member-init` finding at
`backend\src\project\ProjectPerformanceTrace.h:86`. No new findings, suppression
or unrelated source fix was introduced.

A subsequent workspace-only lint cleanup removed the redundant initializer
from `ProjectPerformanceTrace::Timestamp started`. Full strict clang-tidy
22.1.8 then passed all 162 production translation units, and all four
`ProjectTrace_` regressions passed against the rebuilt Debug engine. The
historical S1 lint reports and benchmark packages were not rewritten.

S1's complete package fingerprint is:

```text
7afb477cbab84f7cb1ad18156683e62d20f8b8753cdcba3d2c4b64bc954061c7
```

Source snapshots, native/E2E/lint evidence, attribution, source-comparison
details and final preservation checks are at repository-root
`.cache\performance\persistence-20261105T205045`. The initial pre-format stage
and its results remain at `.cache\performance\persistence-20261105T203717`;
that package is not used in the comparison. Raw reports, traces, profiles,
screenshots and exact collectors are retained relative to `frontend`:

```text
.cache\performance\persistence-traces-2026-11-05T21-07-22-059Z
.cache\performance\persistence-screen-2026-11-05T21-08-55-583Z
.cache\performance\persistence-resources-2026-11-05T21-35-28-376Z
```

All eight earlier package fingerprints and all six fixture fingerprints remain
unchanged; no recorded experiment processes remained. Five ordinary pairs do
not establish rare-failure reliability, and the historical no-PONG cause
remains unproved. No installer, distribution archive, installation, commit,
tag or release was created.

## Stress memory follow-up

The S1 screen's +7.7% stress sampled-private difference was investigated
without changing production code or replacing any earlier sample. Approximate
phase alignment places the original ten stress peaks during scrolling or
zooming, before Save As. That does not exclude an effect from S1's earlier
project-load snapshot, but the post-Save As work itself cannot explain those
earlier peaks. The old reports did not record Electron process roles.

A separate fixed study ran five identical-binary R2/R2 A/A pairs and five
R2/S1 A/B pairs: 20 trials, alternating arm and pair-block order. It retained
the v3 interaction workload, fresh profiles/copied projects, disabled native
tracing and the unchanged 2,048 MiB / 60-second guards. Electron process roles
and asynchronous phase-boundary process-memory snapshots were added equally
to all arms. No CDP heap session or allocation profiler ran during the
interaction workload.

The original-window sample count was recorded before a separate two-second
unforced-idle tail and post-workload heap/GC diagnostic. The table excludes
that tail and GC; the guards still cover them. All 20 trials qualified, with
complete waveforms, correct native saves, stable backend PIDs and no
renderer/lifecycle errors. All ten matched pairs had equal path-normalised
authoritative snapshots.

| Contrast | First-arm median peak private | Second-arm median peak private | Median paired change | Descriptive 95% paired interval |
| -------- | ----------------------------: | -----------------------------: | -------------------: | -----------------------------: |
| Identical R2 / R2 | 811.7 MiB | 778.7 MiB | -4.26% | -8.35% to -1.32% |
| R2 / S1 | 792.4 MiB | 800.4 MiB | -0.52% | -2.68% to +7.56% |

Percentages are paired log-ratio estimates, not ratios of separate medians.
The identical binary produced paired differences of 10.9-71.0 MiB in
magnitude, demonstrating that this small study can show an apparent
directional effect without a code change. Those observations are not a
universal noise threshold. The R2/S1 increase did not reproduce consistently;
its paired differences ranged from -20.8 to +56.1 MiB.

Role attribution places the combined peaks during scrolling/zooming in this
study too. Renderer process peaks varied from 181.3 to 266.3 MiB across R2
runs and 204.6 to 262.8 MiB across S1 runs. Native peaks across all arms stayed
at 136.8-137.5 MiB. R2/S1 median individual GPU-process peaks were 372.8 and
372.4 MiB; separate process maxima occur at different times and must not be
summed into a combined peak.

Immediately before diagnostic GC, renderer private memory was 187.4-213.5 MiB.
The separate GC diagnostic reduced it to 112.6-128.3 MiB. V8's reported total
heap size fell from 78.7-93.7 MiB to 20.7-22.0 MiB, and used heap converged to
19.326-19.379 MiB across all 20 trials. This supports substantial transient
allocation/collection variability rather than equivalent retained live data.
GPU-process private bytes remained variable and are not GPU-live allocations.

The evidence does **not** establish a repeatable S1-specific retained-memory
regression or identify the exact allocation responsible for the original
difference. Five pairs per contrast, phase-boundary observer effects and
post-GC convergence cannot prove absence of a smaller regression or leak.
The original +7.7% result remains recorded above; it is not retrospectively
discarded or reclassified as a gain. No speculative cache, forced production
GC, sampling change or memory-budget relaxation was introduced.

Protocol, original-peak attribution, all comparisons and integrity ledger are
at repository-root `.cache\performance\stress-memory-20261105T215424`.
Raw reports, process-role/phase snapshots, post-workload heap diagnostics,
screenshots and exact collector/helpers are retained relative to `frontend`:

```text
.cache\performance\stress-memory-screen-2026-11-05T21-55-57-137Z
```

Both studied packages, all eight earlier reference packages and all six corpus
fingerprints remain unchanged. No recorded experiment processes remained.
No application code, installer, distribution archive, commit, tag or release
was created.

## Combined reference screen

On 2026-11-06, the preserved M1 package (before C1/R1/R2/S1) was compared with
the final preserved S1 package containing all four changes. Their fingerprints
are `c963599405f4354422a5a705c70c6f0eadca333613429e656553d4eb9114beab`
and `7afb477cbab84f7cb1ad18156683e62d20f8b8753cdcba3d2c4b64bc954061c7`.
Only `resources\app.asar` and the packaged backend executable differ;
Electron and the other runtime files are unchanged. This is a total comparison
against M1, not against released 1.9.0. No package was rebuilt: the later
workspace lint-only, documentation and pnpm-policy cleanup are not in S1.

The fixed schedule used five alternating pairs per case, serial round-robin:
60 trials with fresh profiles/project copies, the existing v3 workload and the
same passive Save As observer/snapshot wait in both arms. Native tracing,
profiling and forced GC were disabled. The 2,048 MiB and 60-second guards were
unchanged. Machine/GPU/viewport checks and the Windows power scheme matched;
OS caches and outside activity on the shared machine remain uncontrolled.

The candidate qualified **30/30**, the reference **29/30**. The screen therefore
**failed full-corpus qualification**. `chopped-3-control` restarted during
project open at `2026-11-06T09:04:33.292Z` after
`no PONG after 3 probes`. Its report, screenshot, UI text and temporary evidence
remain preserved, without replacement trials. Tracing was disabled, so no
native failure stack/phase trace was captured. The cause remains unproved,
and the clean candidate screen does not prove the watchdog issue is fixed.
All chopped comparative metrics are excluded, not computed from survivors.

All 59 successful trials passed native content, complete-waveform,
backend-PID and renderer/lifecycle checks. All 29 successful matched pairs had
equal full authoritative snapshots after normalising only the per-trial
project-directory prefix. Their complete native saved JSON payloads also
matched after that path normalisation and excluding the top-level wall-clock
`savedAt` written by `ProjectFile::save`. Original files, timestamps, schema/app
versions and all project fields remain archived; no processing field was
excluded.

| Case | Reference / candidate qualified | Reference median shell-open | Candidate median shell-open | Median paired change | Descriptive 95% paired interval |
| ---- | ------------------------------: | --------------------------: | --------------------------: | -------------------: | -----------------------------: |
| `smoke` | 5/5 / 5/5 | 2.98 s | 2.52 s | -17.1% | -48.1% to +1.0% |
| `large` | 5/5 / 5/5 | 3.52 s | 2.48 s | -30.1% | -35.2% to -20.1% |
| `stress` | 5/5 / 5/5 | 5.61 s | 3.01 s | -48.2% | -55.3% to -46.1% |
| `extreme` | 5/5 / 5/5 | 8.90 s | 3.11 s | -63.0% | -67.3% to -55.1% |
| `chopped` | 4/5 / 5/5 | excluded | excluded | excluded | excluded |
| `longform` | 5/5 / 5/5 | 2.78 s | 2.50 s | -1.5% | -27.8% to +1.7% |

Large/stress/extreme show opening gains; smoke/longform do not establish a
clear gain. Paired changes are median log(candidate/reference), not ratios of
separate medians. Intervals use 10,000 deterministic bootstrap resamples of
five pairs and remain descriptive. Shell-open ends at shell/canvas plus two
RAFs; later complete-waveform qualification is not a timed readiness endpoint
or a guarantee of GPU presentation.

| Case | Reference median sampled peak private | Candidate median sampled peak private | Median paired change | Descriptive 95% paired interval |
| ---- | ------------------------------------: | ------------------------------------: | -------------------: | -----------------------------: |
| `smoke` | 608.0 MiB | 564.6 MiB | -7.7% | -12.5% to -5.0% |
| `large` | 840.1 MiB | 654.2 MiB | -22.4% | -24.1% to -21.8% |
| `stress` | 1,035.0 MiB | 814.7 MiB | -21.6% | -26.2% to -18.5% |
| `extreme` | 1,224.2 MiB | 984.0 MiB | -20.0% | -22.9% to -16.7% |
| `chopped` | excluded | excluded | excluded | excluded |
| `longform` | 936.3 MiB | 601.7 MiB | -36.1% | -36.7% to -33.9% |

These are one-second combined private-memory samples, not instantaneous
high-water marks or GPU-live bytes. The earlier A/A study shows that smaller
memory differences can arise without a code change; its spread is not a
universal threshold. Sampled-window CPU medians also fell in the paired
stress/extreme/longform comparisons by 14.8%/16.0%/14.7%, with descriptive
intervals excluding zero. This does not measure whole-process CPU cost.

Rendering throughput did **not** improve clearly. Median paired scroll/zoom
RAF p95 changes were about +/-0.6%, but **two extreme candidate trials**
(pairs 2 and 4) had scroll p95 of 33.3 and 33.2 ms versus 17.0 ms in their
reference trials. All five extreme reference scroll p95 values were
16.9-17.0 ms; candidate scroll p99 remained around 33.4 ms, similar to control.
The paired p95 interval reaches +95.9%. These slower-tail observations are
retained and require responsiveness/allocation profiling, not a claim that
lower memory makes rendering smoother or proof of a particular cause.

| Case | Reference median Save As snapshot receipt | Candidate median Save As snapshot receipt | Median paired change | Descriptive 95% paired interval |
| ---- | ---------------------------------------: | ---------------------------------------: | -------------------: | -----------------------------: |
| `smoke` | 31.4 ms | 43.3 ms | +24.8% | -26.7% to +93.2% |
| `large` | 41.3 ms | 51.7 ms | +36.3% | -33.8% to +95.4% |
| `stress` | 76.6 ms | 71.2 ms | -10.0% | -18.5% to +1.4% |
| `extreme` | 159.1 ms | 157.6 ms | -3.1% | -37.1% to +4.5% |
| `longform` | 24.5 ms | 27.5 ms | +17.3% | -18.4% to +26.8% |

Every eligible snapshot interval includes zero; no clear combined Save As
gain is established. The median paired absolute increases in smoke/large/
longform were 8.6/15.0/4.9 ms. The dense chopped comparison, where S1's earlier
stage-local benefit was measured, is unavailable here. Acknowledgement
intervals also include zero. Observer timings include event delivery and have
no same-endpoint A/A calibration; they are not isolated native CPU, disk-write,
Ctrl+S or renderer-paint timings. Earlier S1 results remain separate evidence.

The manifest, analyses, 59 archived native saves and final integrity/cleanup
ledger are at repository-root `.cache\performance\combined-20261106T085148`.
Raw reports, screenshots, failure evidence and exact collector/helpers are
retained relative to `frontend`:

```text
.cache\performance\combined-screen-2026-11-06T08-52-00-495Z
```

Both studied packages, all eight earlier reference packages and all six corpus
fingerprints remained unchanged. No recorded experiment processes remained.
Windows denied complete cleanup of residual files in all 59 successful
temporary copies; their exact paths/errors are recorded, and the failed
trial's directory is deliberately retained. No permissions/security controls
were changed to force deletion. No application code, distribution build,
installation, commit, tag or release was created.

## Remaining-work investigation (2026-11-06)

These are separate fixed diagnostic studies, not replacements for the combined
screen or its failed reference trials. Important measurement and disposition
decisions were rubber-ducked. No production change or distribution rebuild was
justified; the watchdog, readiness barriers and original deadlines are unchanged.

### Extreme scroll attribution

Ten alternating ordinary `R1`/`R2` extreme pairs isolated the renderer resource
ownership change. All **20/20** ordinary trials passed content, waveform,
lifecycle and PID checks. Archived raw RAF intervals reproduce every reported
frame summary.

| RAF p95 | Control median | Candidate median | Median paired change | Descriptive 95% paired interval |
| --- | ---: | ---: | ---: | ---: |
| Idle | 17.10 ms | 17.15 ms | +0.00% | 0.00% to +1.19% |
| Scroll | 17.10 ms | 17.30 ms | +0.58% | -0.19% to +41.39% |
| Zoom | 16.95 ms | 17.10 ms | +0.59% | -0.85% to +1.78% |

The ten-pair intervals use 10,000 deterministic resamples of paired log ratios,
not population confidence or rare-failure guarantees. Scroll p95 reached
33-50 ms in **2/10 control** and **4/10 candidate** trials. Pairs 1 and 2 slowed
in both arms; candidate-only pairs 6 and 10 reached 50.0/33.2 ms against
16.9/16.9 ms controls. The shared machine and OS cache were uncontrolled.
The candidate-only tails and the original combined-screen concern are retained:
neither a regression nor its absence is established by median parity.

Three separately, equally profiled pairs followed the ordinary schedule.
Only **3/6** captures completed: one complete pair and one additional control.
The other three exceeded the existing ten-second Chrome trace-completion
deadline after the workload; their failed attempts and CPU files remain.
Completed traces showed inclusive renderer-main task maxima of 35.1/38.8 ms
in the pair and 37.0 ms in the extra control, with 49/48/49 tasks exceeding
16.667 ms. Nested frame/task durations include waiting and cannot be added as
CPU time. CPU profiles contain unattributed native samples, negative timestamp
deltas and mean sampling intervals below the requested 1,000 microseconds.
They do not identify a reliable JavaScript allocation hotspot or explain the
candidate-only ordinary tails. No pooling, repaint or overscan rewrite was made.
Controlled renderer/GPU attribution remains engineering work, not only manual
acceptance.

The earlier startup-only interrupted capture is retained separately. A collector
profile-flag name collision was corrected before this fresh schedule; bounded
native and GUI startup preflights passed. The unusually extended earlier
interruption is unexplained, not rendering evidence. The profile cleanup helper
was subsequently corrected to retain the original failure and release its CDP
session once; focused success/failure checks passed without extending deadlines
or rerunning failed profiles.

The manifest is at repository-root
`.cache\performance\scroll-investigation-20261106T103908\packages.json`.
Raw reports, `analysis-v2.json`, CPU-integrity notes and the native-save ledger
are relative to `frontend`:

```text
.cache\performance\scroll-investigation-2026-11-06T10-39-25-980Z
```

All **23** successful native saves were archived; **11** complete successful
snapshot/native-file pairs matched under the combined screen's declared
normalization. Cleanup of successful temporary copies was interrupted after
exceeding 120 seconds; remaining contents/completion are unknown, while raw
reports and archived saves are retained. Failed directories were not selected
for deletion. No permissions were changed or further deletion forced.

### Native watchdog attribution

Ten alternating native-traced `M1`/`S1` chopped pairs used the unchanged workload
and guards without a renderer profiler. The reference passed **4/10**; final
`S1` passed **10/10**. All six reference failures were project-opening restarts
after three unanswered PING probes.

The failed original engine's flushed records still show `rebuildEngine`, with
no `PROJECT_LOAD` return before termination. Last progress records were at
11.026-12.037 seconds; 1,820-2,031 of 2,048 source-preparation calls had completed,
totalling 9.408-10.416 seconds. This is completed-span evidence, not an in-flight
stack or a prediction that loading would finish shortly.

All recorded pre-failure PING guard reads showed ready, recovery `ok`, stopped
and not importing. Unanswered wire probes overlapped the in-progress synchronous
message-thread rebuild. This directly locates occupancy in failed trials rather
than inferring it from successful loads, but wire observation and asynchronous
guard reads are not native PING-receipt timestamps or renderer attribution.

The current candidate completed all ten loads in 1.322-1.426 seconds; its 2,048
completed preparation calls totalled 0.251-0.279 seconds per load. These are
candidate absolute observations, not a survivor-based speed comparison. They
are consistent with C1 removing unconditional preparation sleeps; `S1` also
contains R1/R2/S1, so this study does not isolate C1-only causation or establish
universal reliability. The existing preparation change addresses the recorded
cost; no new current-build fix was justified.

PING still runs on the message thread to prove command responsiveness.
Extending the watchdog or moving PONG to the I/O thread would hide this class
of occupancy rather than fix it. A sufficiently long synchronous load could
still exceed the window; that residual risk is not eliminated by ten passes.
Historical chopped comparisons remain excluded, not repaired by this study.

The manifest is at repository-root
`.cache\performance\watchdog-investigation-20261106T103908\packages.json`.
Raw phase/wire evidence, analysis, **14** archived native saves and **4** matching
successful snapshot/native-file pairs are relative to `frontend`:

```text
.cache\performance\watchdog-investigation-2026-11-06T10-55-11-803Z
```

Failed directories and successful temporary copies are retained; further profile
cleanup was deliberately not attempted after the earlier stall.

### Silent native playback and scope timing

Three fixed attempts per case ran the preserved final `S1` native engine without
a renderer. All **18/18** passed the functional transport, device, content and
owned-process checks. Each attempt used unchanged fresh fixture copies, verified
zero master gain and disabled metronome, and allowed the callback gain ramp to
settle before playback. Keep-awake was disabled. There was no microphone capture,
audible programme, device selection, driver installation or preference change.

The existing atomic `MasterClockSource` timing was drained by `PlayheadEmitter`
on its message-thread timer: no new callback instrumentation was added. Across
all attempts, Windows Audio stayed at **48 kHz / 480 frames**, a nominal
**10 ms** block budget and **10 ms reported output latency**. Ninety one-second
drains were wholly inside six-second steady-playing windows, fifteen per case.
Startup, load and play/seek transition drains were excluded.

**This is not real-time acceptance.** Chopped scope maxima were
**14.533 / 15.296 / 15.972 ms** across the three attempts. Thirteen of its fifteen
steady drain windows exceeded the nominal 10 ms budget. Extreme reached
9.337 ms, leaving little measured scope margin before downstream work. These
are elapsed-time maxima, including possible preemption, not isolated CPU time.

| Case | Largest measured scope | Nominal budget used | Observed PLAY median | Observed rolling-SEEK median |
| --- | ---: | ---: | ---: | ---: |
| `smoke` | 0.740 ms | 7.4% | 27.2 ms | 17.4 ms |
| `large` | 2.340 ms | 23.4% | 27.5 ms | 23.2 ms |
| `stress` | 5.574 ms | 55.7% | 33.8 ms | 56.4 ms |
| `extreme` | 9.337 ms | 93.4% | 47.8 ms | 137.0 ms |
| `chopped` | 15.972 ms | 159.7% | 80.5 ms | 419.7 ms |
| `longform` | 1.068 ms | 10.7% | 20.8 ms | 17.4 ms |

PLAY medians combine initial starts and deep stopped-seek restarts, six
observations per case. Rolling-SEEK has three observations per case. Stopped
seek medians were 16.4-18.2 ms. These endpoints are command send to a qualifying
**latency-compensated bridge playhead update**, including timer and event
delivery, not first-callback or acoustic latency.

The timed scope excludes downstream top-mixer, master metering, output limiter,
AudioSourcePlayer and device work. Zero master gain preserves upstream processing
but changes downstream metering/limiter load. No warnings/errors were recorded
and callback counts continued advancing; neither fact establishes absence of
dropouts. Complete-callback timing, device xruns and acoustic latency were not
measured. These synthetic arrangements have no active clip warps or third-party
plugins and do not replace real-project or hardware/listening acceptance.

Source inspection identified a hypothesis, not a sampled hotspot:
`BusGraphRender.cpp` subdivides every track when any track has automation, using
the 256-frame quantum in `BusGraph.h`. Each sub-block pulls every attached clip
source. A 480-frame callback can therefore make up to **4,096 source pulls**
for the 2,048-clip chopped arrangement. Per-clip transports sit downstream of
buffering and window-silence handling; merely skipping future clips would stop
their transport advancement. Increasing the quantum changes automation
granularity. A once-per-block clip-summing proposal would need native attribution
and gain-ramp, seek/tail, live-edit, beat-repeat, plugin and automation-parity
evidence before any real-time change. Rubber-duck review supported recording the
finding rather than guessing at such a rewrite.

`analysis-v2.json` explicitly separates functional qualification from
`exceedance-observed-unresolved`; the original analysis remains preserved.
Raw logs, timing windows, transport events, unchanged fixture copies and hashes
are at repository-root:

```text
.cache\performance\native-audio-20261106T110401
```

No new production fix was justified. The chopped scope-budget exceedance and
near-budget extreme case remain engineering findings, not merely manual tests.

## Recorded diverse baseline

On 2026-11-05, all six projects in `corpus-diverse-v2` received exactly five
serial trials against the unchanged frozen packaged 1.10.0 build. Cases ran
round-robin in the order `smoke`, `large`, `stress`, `extreme`, `chopped`,
`longform`, without replacement trials or discarded failures. This package
does **not** contain the worktree's Windows bridge polling fix.

| Case       | Tracks | Clips | Qualified trials | Median open to shell | Median scroll RAF p95 | Median sampled peak private memory |
| ---------- | -----: | ----: | ---------------: | -------------------: | --------------------: | ---------------------------------: |
| `smoke`    |      8 |    32 |              5/5 |               3.22 s |               17.0 ms |                          621.7 MiB |
| `large`    |     16 |   128 |              5/5 |               3.60 s |               17.0 ms |                          845.7 MiB |
| `stress`   |     32 |   512 |              5/5 |               6.24 s |               17.0 ms |                        1,008.2 MiB |
| `extreme`  |     64 |  1024 |              2/5 |                    - |                     - |                                  - |
| `chopped`  |     24 |  2048 |              1/5 |                    - |                     - |                                  - |
| `longform` |      8 |    32 |              5/5 |               3.55 s |               17.0 ms |                          947.3 MiB |

`extreme` timed out waiting for the native Save As file in three trials.
`chopped` failed during project open with native restarts in three trials and
timed out waiting for the native Save As file in one. These wait labels do not
prove that the native writer was executing. These failure rates are part of
the baseline. Successful subsets are preserved, but must not be used
to claim representative timing improvements. Their aggregate reports remain
`failed`, so `perf:compare` rejects them. `smoke` remains a harness check, not a
capacity claim.

Every successful trial passed native save-content checks, retained the same
backend PID, and had no renderer errors or unexpected native lifecycle events.
Read-only diagnostic inspection **after** timing and resource sampling verified
that every clip had waveform data and none were unresolved. This additional
qualification does not instrument the timed workload or add a production API;
it does not measure when each waveform finished or prove GPU presentation.
Screenshots record the post-workload viewport, which can be outside the clips
after zooming, rather than asserting that clips are visible at that position.

Settings: workload version 3, 1440 x 900 CSS-pixel viewport, DPR 1.25,
60 warm-up frames, 180 idle frames, 48 wheel steps per action, 60,000 ms workload
timeout, 2,048 MiB sampled private-memory guard, one-second sampling, logging
disabled and no playback. The environment label for matching comparisons is
`local-frozen-1.10.0-diverse-v2-2026-11-05-no-playback`.

The complete packaged-directory fingerprint is:

```text
42a4791d8489a06a8fa112b736557e1303e3acb7dfa9ea172b971b296c93e2d3
```

Raw results, screenshots, per-trial evidence paths, aggregate `<case>.json`
reports, `summary.json` and the hashed collection script are preserved here,
relative to `frontend`:

```text
.cache\performance\baseline-diverse-v2-2026-11-05T12-29-41-870Z
```

The collector is archived as `capture-current-baselines.mjs.txt`; its content
hash is recorded in `summary.json`.

All 30 reports and successful waveform qualifications were checked, and the
package and corpus hashes were verified unchanged after capture. Raw `.cache`
artifacts are local and gitignored: pushing source does not upload them.
Keep this directory, the corpus and the frozen package together. Earlier
baselines and failed diagnostics remain untouched.

## Historical simple baseline

On 2026-11-04, all three working cases completed five serial repetitions against
the frozen packaged 1.10.0 build on the local machine. Every repetition opened,
scrolled, zoomed and saved with the expected track, clip and source counts.

| Case      | Tracks | Clips | Median open to shell |    Open range |
| --------- | -----: | ----: | -------------------: | ------------: |
| `large`   |     16 |    64 |              1.479 s | 1.442-1.952 s |
| `stress`  |     32 |   128 |              1.964 s | 1.938-2.488 s |
| `extreme` |     64 |   256 |              2.993 s | 2.986-3.145 s |

These are local observations, not capacity or full-waveform-readiness claims.
The three `.cache\performance\baseline-working-<case>.json` files retain build
and fixture fingerprints, environment, frame/resource samples and settings;
`baseline-working-summary.json` summarises them. These are local generated
artefacts, not committed fixtures. Preserve them with the baseline package.

To reproduce the workload, use the same controls for both baseline and
candidate, changing only the packaged executable and output names:

```powershell
pnpm perf:run --app ..\.cache\performance\baseline-1.10.0\Silverdaw.exe --corpus .cache\performance\corpus-working-v1 --case large --environment "local-working-baseline-2026-11-04-no-playback" --output .cache\performance\baseline-working-large.json --runs 5 --frames 180 --steps 48 --timeout-ms 30000 --max-private-mib 2048
```

Use `--case stress` and `--case extreme` for the other two cases. Existing
output files are never overwritten. This historical corpus must now be
selected explicitly; the default is `.cache\performance\corpus-diverse-v2`.
Its fingerprints differ from the varied recipes, so the two are not an
optimisation A/B comparison. Windows denied removal of some isolated
profile-cache files; those cleanup warnings are recorded separately and do not
alter the measured samples. No playback was automated.

## Initial large-session observation

Before the 75% reduction, the packaged 1.10.0 build failed both initial
256-track/20,000-clip `large` attempts on 2026-11-04:
the backend supervisor requested a restart after three unanswered health
probes during project loading. These are failed runs, not accepted timing
baselines or proof of a crash. Smaller cases can supply measurement baselines;
the long-load/health-check issue remains separate. Do not mask it by relaxing
checks or assume every reduced case loads without verifying it.
Failed reports retain resource samples, the workload phase, native PIDs,
relevant lifecycle messages and the temporary evidence directory.
