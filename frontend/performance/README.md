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

The current corpus has [recorded five-trial results](#recorded-diverse-baseline)
for all six generated projects. Four cases qualify as timing baselines;
`extreme` and `chopped` have recorded failure baselines, not reliable timing
baselines. Do not accept projects on shell/canvas readiness alone or treat
missing waveforms as an established GPU-rendering defect.

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

`extreme` timed out during native Save As file writing in three trials.
`chopped` failed during project open with native restarts in three trials and
timed out during native Save As file writing in one. These failure rates are
part of the baseline. Successful subsets are preserved, but must not be used
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
