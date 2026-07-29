# End-to-end tests

Playwright drives a real, built Silverdaw — a real Electron main process, a real
renderer, and a real JUCE backend spawned over the loopback bridge. This is the
only tier that can prove the two processes still agree with each other, so it
complements the Vitest suites rather than overlapping them. ADR 0014 anticipates
this tier.

Keep it small. Every journey costs seconds of wall clock and a share of the
maintenance budget, so the suite is deliberately a handful of wide journeys
rather than a broad grid.

## Running

```text
pnpm build         # required — the specs launch out/, never the dev server
pnpm test:e2e
pnpm test:e2e:report
```

`pnpm build` is not automatic. A stale `out/` will happily pass while testing
code you have already changed, so rebuild before trusting a green run.

## What the specs assert

Assertions target what a user can observe — DOM state, files on disk, and the
saved project document — rather than internal stores. That constraint is what
keeps the tier honest: it cannot pass by agreeing with the implementation.

The timeline is a PixiJS canvas with no DOM, so clip-level state is verified
indirectly through the saved `.silverdaw` file instead of by reading pixels.

Where a journey covers a race — a button pressed the moment it appears — it
clicks **once**. Retrying a click turns a dropped action into a passing test and
hides exactly the defect the journey exists to find.

## Isolation

Each launch gets a throwaway `--user-data-dir`, which isolates preferences,
recent projects, and Electron's single-instance lock. A spec can therefore run
while an ordinary Silverdaw is open.

`~/Silverdaw/{Logs,Diagnostics,Models}` is **not** isolated. Electron resolves
`home` from the Windows shell API rather than the environment, so it cannot be
redirected from a test. Accepted as a known gap: these directories are
append-only diagnostics, and the tier is a local pre-release gate rather than a
shared-CI one.

Launches seed `preferences.json` with `debug.loggingEnabled`, so a failing run
leaves a full session log under `~/Silverdaw/Logs` — usually the fastest route
to the cause of a silent cross-process failure.

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

## Native dialogs

Playwright cannot drive an OS file picker. `helpers/dialogs.ts` monkey-patches
Electron's `dialog` module inside the running main process, which keeps the
production code free of test-only branches.
