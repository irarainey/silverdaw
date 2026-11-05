# Performance benchmarks

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

Source preparation ran once per clip. The current JUCE buffering preparation
loop sleeps for 5 ms on every newly prepared buffer, consistent with the
observed serial warmup cost. This makes preparation the first measured native
opening candidate, not graph publication. Read-ahead readiness and publication
lifetimes have not been changed.

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
