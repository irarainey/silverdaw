# End-to-end tests

Playwright launches the built, unpackaged Electron app. Its main process
spawns the JUCE backend and the renderer connects over the loopback bridge.
This tests cross-process behaviour that neither Vitest nor CTest can cover
alone; see [ADR 0014](../../docs/adr/0014-testing-strategy.md).

Prefer a wide journey over a grid of UI cases. Playwright runs one worker
because each launch starts its own engine and opens an audio device.

## Running

Large-session packaged performance projects and opt-in measurements are
documented in [performance benchmarks](../performance/README.md). They are not
collected by the normal E2E suite.

From the repository root, run the full suite with one command:

```powershell
pnpm test:e2e
```

Pass a journey name to run just that test: `pnpm test:e2e automation-steps`.

Alternatively, run from `frontend`:

```powershell
pnpm test:e2e         # builds out/, then runs the suite
pnpm test:e2e:only    # skips the build — only when out/ is known current
pnpm test:e2e:report  # opens an existing Playwright HTML report
```

Local runs keep Electron on a private Windows desktop that is never shown or
switched to. The tests still exercise real windows, including maximising them.
The launcher requires Python 3 on `PATH` as `python`; no Python packages are
needed. The terminal prints each journey and its actions as they start.
CI keeps its existing runner and HTML report.

To watch a journey while debugging, set `$env:SILVERDAW_E2E_HEADED = '1'`
before running it. Use `Remove-Item Env:SILVERDAW_E2E_HEADED` to return to
hidden runs.

`test:e2e` builds first on purpose. A stale `out/` passes happily while testing
code you have already changed, which has now happened more than once; the few
seconds of build are cheaper than trusting a green run that meant nothing. Use
`test:e2e:only` for a tight loop when you have not touched `src/`.

`e2e/globalSetup.ts` enforces that: before any spec runs it compares the mtimes
of `out/{main,preload,renderer}` against `src/` and `electron.vite.config.ts`,
and aborts the run with a build hint if the bundles are missing or older. So
`test:e2e:only` can no longer silently test stale code.

### From the VS Code Testing panel

Install the recommended `ms-playwright.playwright` extension (see
`.vscode/extensions.json`). It discovers `frontend/playwright.config.ts` on its
own, and the journeys appear in the Testing panel next to the CTest-provided
backend tests — no extra configuration.

The panel's ▶ runs the Playwright runner directly, exactly like
`test:e2e:only`, so it does **not** build first. Discovery is unaffected — the
tests always list — but a run against stale bundles stops at the freshness
guard above. Run the `frontend: build` task (or `pnpm build` from `frontend`)
after changing `src/`, then re-run.

The e2e tier does not build or freshness-check the C++ backend. The unpackaged
app expects `backend/build/SilverdawBackend_artefacts/<config>/SilverdawBackend.exe`;
`SILVERDAW_BACKEND_CONFIG` defaults to `Debug`. Rebuild that configuration
after a native change.

## What the specs assert

Assertions target what a user can observe — DOM state, files on disk, and the
saved project document — rather than internal stores. That constraint is what
keeps the tier honest: it cannot pass by agreeing with the implementation.

The timeline is a PixiJS canvas with no DOM, so clip-level state is verified
indirectly through the saved `.silverdaw` file instead of by reading pixels
(`helpers/projectDocument.ts` addresses nodes by `$type`, since nesting is by
container).
Placing a clip is reachable without touching the canvas: the track header's
import button imports and places in one click, and it disables itself once its
track holds a clip, which gives a DOM-observable signal that the clip landed.
Dragging from the library is native HTML5 drag-and-drop with custom MIME data,
which a test can only fake by synthesising the events a browser would otherwise
generate — that asserts the implementation, so specs take the button instead.

Use browser-level pointer input for gestures that live on a canvas. For
example, `helpers/timeline.ts` seeks or selects a range on the ruler and
double-clicks a clip to open its editor. It locates these targets from the
header-resize divider so a resized column cannot move a gesture into the
headers. The sample-import journey also drags out a region in the clip editor.

The range-export journey in `export-mixdown.e2e.ts` compares both the mixdown
and each exported track's WAV length with the selected range saved in the
project. `renderer-recovery.e2e.ts` deliberately loses the timeline's WebGL
context, checks that the replacement canvas and the open editor have live
contexts, then verifies the saved clip. Neither check reads canvas pixels.

`sample-report.e2e.ts` checks the report dialog and the PDF on disk, including
landscape pages, the timestamped default filename, and which project's export
folder is used. `sample-report-provenance.e2e.ts` opens a legacy project and
checks that an exact passage, a scratch input window, and an unknown range
remain distinguishable in the report.

Markers are the sharpest case of a canvas-only feature: they are placed with a
bare `M`, drawn only on the ruler, and have no DOM at all. `markers.e2e.ts`
reads them through Edit ▸ Clear All Markers instead, which is enabled exactly
when the project holds at least one marker — a signal the user can see, and the
same one that tells them the command is worth reaching for.

`mixer-state.e2e.ts` addresses track controls by position rather than by a
per-track hook, because the header rows render in track order and every value it
sets is per-track. Reading the third fader and finding the second track's value
is the defect the journey exists to catch, so it uses three tracks and checks the
neighbours it never touched.

Where a journey covers a race — a button pressed the moment it appears — it
clicks **once**. Retrying a click turns a dropped action into a passing test and
hides exactly the defect the journey exists to find. Opening the menu bar is the
one exception, and only in the markers journey: the bar rebuilds on every
project-state change and drops whatever was open, so an open issued right after
a keypress can be discarded before it is read. The journey retries opening
the menu and reading **Clear All Markers** until its enabled state settles;
it does not repeat the marker edit.

### Windows title-bar hit regions

Browser-driven clicks bypass Windows non-client hit-testing, so passing menu
journeys alone cannot prove a physical mouse click reaches a title-bar button.
`titlebar-menus.e2e.ts` also queries `WM_NCHITTEST` on its own app window using
`helpers/windowHitTest.ts`, with DPI-aware screen coordinates and bounded waits.
It checks menus, project-name controls and window buttons remain client areas,
while the brand and empty spacer remain draggable, restored and maximised.
It does not move the OS cursor or send input to another application.

### The playback journey needs an audio device

`playback.e2e.ts` requires a working output endpoint. The playhead is
advanced by `MasterClockSource` from inside the audio device callback, so a
position that moves is the only end-to-end proof that a device opened and its
callback is firing — nothing offline can stand in for it, and its absence is
how a frozen-playhead regression once passed the entire suite.

With no output device the engine reports `no_device` and the renderer disables
Play, so the spec fails on a disabled button rather than on a stalled playhead.
On CI, `scripts/Install-VirtualAudioDevice.ps1` provides the device; see the
developer guide's continuous-integration section.

Its fixture is digital silence — `createToneWav({ amplitude: 0 })`. The
callback fires regardless of what the samples contain, so silence proves the
same thing without the suite making an audible noise on whatever machine runs
it. `record-audio.e2e.ts` exercises input discovery and closing the session,
but accepts either an available input or the no-input state. It does not
record a take or validate microphone capture.

## Isolation

Each launch gets a throwaway `--user-data-dir`, which isolates preferences,
recent projects, and Electron's single-instance lock. A spec can therefore run
while an ordinary Silverdaw is open.

A journey that has to prove state survives a restart is the one exception: pass
`launchApp({ userDataDir })` to relaunch onto the profile the previous session
wrote, and close that session with `closeSilverdaw(app, { keepProfile: true })`.
Without the flag the directory is deleted, Electron silently recreates an empty
one, and the second session reads defaults — indistinguishable from the
persistence bug the journey exists to catch. Seeding options are rejected on a
reused profile, since seeding would overwrite the file under test.

`~/Silverdaw/{Logs,Diagnostics,Models}` is **not** isolated. Electron resolves
`home` from the Windows shell API rather than the environment, so it cannot be
redirected from a test. Accepted as a known gap for local runs alongside another
instance: session logs are separate, but startup diagnostics are overwritten
and model caches are shared. Do not clear those directories as test cleanup.
The suite also runs in CI on its own Windows runner, with the backend built by
the native job and a virtual audio output device; see the developer guide's
continuous-integration section.

Because that directory is shared, the diagnostics attached to a failure are
filtered by modification time: a log untouched since the app launched is named
but not quoted. Attaching it wholesale would be worse than attaching nothing,
since it presents an unrelated session as evidence for this failure.

Launches seed `preferences.json` with `debug.loggingEnabled`, so a failing run
leaves a full session log under `~/Silverdaw/Logs` — usually the fastest route
to the cause of a silent cross-process failure.

One journey kills the audio engine on purpose. It resolves the PID through
`helpers/backendProcess.ts`, which only ever matches a `SilverdawBackend.exe`
whose parent is *that test's own* Electron main process. Never match the engine
by name alone: it would find a developer's separately running Silverdaw and kill
their work.

## Temporary artefacts

Journeys synthesise real files — imported WAVs, saved project folders, copies of
the frozen fixture — because that is the only way to exercise the engine's own
decode and write paths. Create them with `makeTrackedTempDir()` from
`helpers/tempDirs.ts` rather than `mkdtemp` directly, and an auto fixture deletes
them once the test passes.

Tracked project and audio artefacts from a **failing** test are deliberately
left on disk, like `trace: 'retain-on-failure'`. The launch fixture still
closes the app and attempts to remove its profile after attaching diagnostics.

## Fixtures

`fixtures/projects/E2E Fixture/` is a real project saved by Silverdaw 1.4.1 and then
frozen. It is the backward-compatibility canary: `CONTEXT.md` makes it a `CRITICAL`
constraint that saved projects keep opening across updates, and Silverdaw
auto-updates from the Microsoft Store, so a reader regression would reach users who
never chose to take it.

**Never regenerate it.** A fixture rewritten by the current build proves only that
today's writer agrees with today's reader — exactly the bug class it exists to catch.

It is portable because its audio sits *inside* the project folder, so the engine
stores that path relative to the folder (`ProjectFile.cpp`, `kPortablePathKeys`) and
the committed artefact carries no machine-specific absolute path.

Specs copy it to a temporary directory before opening it. Opening a project writes
into its folder (metadata, cover art, view state), so opening the committed copy in
place would dirty the working tree and leave later runs testing a mutated artefact.

The MRU list lives in `preferences.json`, so `launchApp({ recentProjects: [...] })`
seeds the start screen's recent list — an isolated profile starts empty by design.

`launchApp` seeds two other pieces of profile state for the same reason, because
each is read from disk at startup and cannot be reached from the UI beforehand:

- `preferences: { ... }` plants extra `preferences.json` keys, so a spec can stand
  up a legacy or partial document and prove the real loader still reads it. The
  merge rules themselves are pure functions covered in `tests/main/preferences.test.ts`;
  reach for this only when the round trip through the file is the point.
- `autosaveBuckets: [...]` plants crash-recovery buckets under `<userData>/autosave/`
  (`helpers/autosaveFixtures.ts`). Startup decides purely from what it finds there,
  so seeding a bucket is both sufficient and far more controllable than staging a
  real crash — the spec chooses the exact recovery state under test. Seeding covers
  the *reader* only, so `autosave-write.e2e.ts` deliberately seeds nothing: it makes
  an edit, waits for the bucket the app itself writes, and restarts onto it. That is
  the one thing seeding can never show — that the writer's output is something the
  reader accepts. It needs no timer, because the autosave manager ticks immediately
  whenever a project becomes dirty (`lib/autosave.ts`).

## Native dialogs

Playwright cannot drive an OS file picker. `helpers/dialogs.ts` monkey-patches
Electron's `dialog` module inside the running main process, which keeps the
production code free of test-only branches.
