# ADR 0014 — Testing strategy

- **Date:** 2026-05-14 · **Amended:** 2026-07-29 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

- **Backend:** a custom `SilverdawBackendTests` harness wired into **CTest** — no
  Catch2, GoogleTest, or other third-party test framework. Cover model
  persistence, bridge-relevant state, timing/warp-ratio math, cache behaviour,
  and every bug fix. Test pure math and state transitions directly; use smoke
  tests for third-party DSP integration where full audio assertions would be
  brittle. Build with `-DSILVERDAW_BUILD_TESTS=ON`, build the
  `SilverdawBackendTests` target, then run:
  `ctest --test-dir backend/build --build-config Debug --output-on-failure`
  (in an MSVC Developer environment — e.g. via `scripts/Invoke-DevShell.ps1`).
- **Frontend:** **Vitest** (+ Vue Test Utils for components) for unit and
  component tests. Test behaviour, not implementation detail. Avoid brittle
  timing assertions — use fake timers or injected clocks. Run targeted specs for
  fast feedback.
- **End-to-end:** **Playwright** (`_electron`) drives the packaged app against a
  real backend. See "End-to-end tier" below.
- **Match the existing harness/framework — never introduce a new one.** This
  binds *within* a tier: do not add a second unit framework beside Vitest, or a
  second backend harness beside `SilverdawBackendTests`. It does not forbid
  adding the tool a tier that does not yet exist requires.

## Test discovery

Each backend case is registered as its own CTest test, discovered at build time:
the harness supports `--list` (print case names) and `--run "<name>"` (run one),
and a POST_BUILD step generates one `add_test` per case (see
`backend/cmake/SilverdawDiscoverTests.cmake`). So individual cases show up in
`ctest` output and the VS Code Testing panel, not just one aggregate row. Keep
test-case names ASCII so they survive the discovery round-trip.

## End-to-end tier

`frontend/e2e/`, run with `pnpm test:e2e`. Playwright's `_electron.launch()`
starts the **built** app (`out/`, not `electron-vite dev`), which spawns the real
C++ backend, so a run exercises the whole spawn → port → AUTH → handshake chain
and the actual project file format. It **supplements** Vitest and CTest and
replaces neither: it covers only what the seam between the two processes can
break, and every journey it owns is one no single-process test can express.

Rules that keep it from becoming the brittle tier:

- **Assert what a user can observe** — DOM, the filesystem, saved project files.
  No production test hooks, and no exposing Pinia stores in a shipped build.
- **Never assert on canvas pixels.** The PixiJS timeline has no DOM and no
  stable pixel output; assert the state behind the drawing instead.
- **Isolate per run** via `--user-data-dir`, which also sidesteps Electron's
  single-instance lock. Note `~/Silverdaw/{Logs,Diagnostics,Models}` **cannot**
  be redirected — Electron resolves `home` from the Windows shell API — so those
  stay shared and must not be asserted on destructively.
- **Stub native dialogs in the main process.** Playwright cannot drive an OS
  dialog; the open/save/message-box handlers are replaced in-process.
- **Keep the journey count low and wide.** Few tests, each crossing many
  subsystems. A journey that only re-covers unit-testable logic should be a
  Vitest spec instead.
- **One frozen project fixture** serves as the backward-compatibility canary that
  ADR 0019 requires. It is a real artefact of a released version and is never
  regenerated — regenerating it would assert only that the current build agrees
  with itself.

Playwright type-checks nothing on its own (it transpiles only), so `e2e/` is
included in `tsconfig.node.json` and covered by `pnpm typecheck`.

## Coverage

Both sides can emit coverage reports. Frontend: `pnpm test:coverage` (Vitest v8
→ `frontend/coverage/`). Backend: `-DSILVERDAW_ENABLE_COVERAGE=ON` adds a
`SilverdawBackendCoverage` target — llvm-cov/gcovr on Clang/GNU, or
**OpenCppCoverage** over the Debug binary on MSVC (HTML + `cobertura.xml` under
`backend/build-coverage/`). `scripts/Coverage.ps1` runs either or both and
collects the viewable HTML reports into one gitignored `coverage/` folder
(`coverage/frontend/`, `coverage/backend/`, `coverage/index.html`).

## Why

- The engine's testing needs are small and self-contained; a bespoke harness
  avoids a third-party dependency (extra `FetchContent` surface, licence, build
  time) for little gain, and keeps CTest the single runner.
- One test stack per side keeps the suite and its tooling coherent.
- The two-process split (ADR 0001) puts real risk in a place neither unit tier
  can reach: the bridge handshake, dialog and filesystem integration, and the
  saved file format. The e2e tier exists for that seam and is deliberately thin
  everywhere else. It earned itself immediately, catching three defects — two
  start-screen actions silently dropped before the bridge was ready (one of which
  left the master at unity instead of the −10 dB default) and a saved project
  never persisting its own name.
- Playwright is Apache-2.0, so it is compatible with the AGPL-3.0 licensing in
  ADR 0010, and its Electron support drives the main and renderer processes from
  one script — which is what makes main-process dialog stubbing possible.

## Rejected alternatives

- **Catch2 / GoogleTest for the backend.** Dependency weight unjustified at
  current scope.
- **A second framework alongside the existing one.** Fragments the suite.
- **Driving `electron-vite dev` instead of the built app.** Would test a bundle
  users never run and skip the packaging step, where several of these failures
  actually live.
- **Exposing the Pinia stores, or dedicated test hooks, in production builds.**
  Ships test scaffolding to users and lets a journey pass while the UI is
  visibly broken. DOM and filesystem assertions cost more to write and are worth
  it.
- **Pixel or screenshot assertions on the PixiJS timeline.** No stable output,
  and failures would not localise to a cause.
- **Regenerating the compatibility fixture each release.** Reduces the
  backward-compatibility check to the build agreeing with itself.
- **A large e2e suite mirroring the unit tests.** Slow, flaky, and duplicative;
  breadth per test is the point, not count.
