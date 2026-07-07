# ADR 0014 — Testing strategy

- **Date:** 2026-05-14 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

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
- **Frontend:** **Vitest** (+ Vue Test Utils for components); Playwright for
  Electron e2e is planned. Test behaviour, not implementation detail. Avoid
  brittle timing assertions — use fake timers or injected clocks. Run targeted
  specs for fast feedback.
- **Match the existing harness/framework — never introduce a new one.**

## Test discovery

Each backend case is registered as its own CTest test, discovered at build time:
the harness supports `--list` (print case names) and `--run "<name>"` (run one),
and a POST_BUILD step generates one `add_test` per case (see
`backend/cmake/SilverdawDiscoverTests.cmake`). So individual cases show up in
`ctest` output and the VS Code Testing panel, not just one aggregate row. Keep
test-case names ASCII so they survive the discovery round-trip.

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

## Rejected alternatives

- **Catch2 / GoogleTest for the backend.** Dependency weight unjustified at
  current scope.
- **A second framework alongside the existing one.** Fragments the suite.
