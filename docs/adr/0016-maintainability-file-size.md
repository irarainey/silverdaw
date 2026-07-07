# ADR 0016 — Maintainability & file-size policy

- **Date:** 2026-05-14 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

Canonical source for the maintainability gate. The path-specific instruction
files under `.github/instructions/` carry only their language's ceiling and
examples and point here.

## Decision

Maintainability is a first-class, **blocking-class** review gate — not a style
nit.

- **One coherent unit of thought per file.** If you can't describe it in one
  short sentence, split it. Line count is a *symptom, not the goal*.
- **Domain separation by default.** Organise by feature/problem domain (clips,
  tracks, transport, library, persistence, waveform/warp, timeline rendering, …),
  not by incidental technical layering. Each distinct domain gets its own
  file/module/translation-unit/composable. "Related" and "only a few lines" are
  never sufficient reasons to co-locate two domains — that is wrong even far
  below any ceiling. Keeping domains together needs an **explicitly-documented,
  exceptional** reason (one inseparable unit; an unavoidable circular dependency;
  see the real-time exception below), recorded in the file and re-evaluated on
  every change.
- **No duplication.** Duplicated logic, dispatch branches, payload shapes, regex,
  or magic constants are defects — require one source of truth (shared
  helper/composable/base type/enum). Reuse before reinventing.
- **Names carry intent; comment the *why*, never the *what*.**

## Authoring-time gate — "Before you add code"

Runs before every edit that adds code to an existing file:

1. **Check where it's going.** Compare the target's current size to its ceiling.
   At or over budget → default to a new focused unit; do not grow it.
2. **Name the responsibility you're adding.** A second reason to change belongs
   in its own unit — independent of line count.
3. **Reject the easy excuses.** "Only a few lines", "it's related", "extract
   later", "just for now" are never sufficient grounds to grow an oversized file.
4. **If your change pushes a file past a ceiling, split in the same change** —
   pure mechanical move, stable facade/barrel re-export so importers don't churn,
   build + tests green. Never leave a newly-oversized file for "later".
5. **When unsure, extract rather than grow.**

## Soft ceilings (scrutinise above)

| Unit | Soft ceiling |
| --- | --- |
| Vue SFC | ~250 lines |
| TS module | ~350 (Pinia stores / large composables — extract helpers early) |
| TS type/schema-only | may run longer |
| C++ `.cpp` | ~500 |
| C++ header | ~250 (declarations only) |
| Any function | ~50 lines, or deeply nested |

**Hard trigger:** ANY file > ~800 lines is a defect to fix — split *now* unless
there is an exceptional, explicitly-stated reason. Aim well below it.

## The one exception

A genuinely cohesive real-time path may stay in a single unit: a DSP
`processBlock` chain, or a timing/warp pipeline whose unit-of-time conversions
must stay together to avoid source-vs-timeline mix-ups. Correctness outweighs the
line count here — do not fragment it to chase a number. Everywhere else, find the
real domain seams first.

## How to split

Pure mechanical moves (no behaviour change); keep `pnpm typecheck` / `lint` /
`test` (or `ctest`) green at each step. Prefer a stable barrel/facade re-export
so importers don't churn (e.g. the `bridge-protocol.ts` facade over
`shared/bridge/*`). A split must genuinely improve maintainability — not a
contrived `part1`/`part2` or a composable that needs a large cross-cutting
"dependency bag". Earlier structure is always revisable: re-split rather than
defend the status quo.

## Why

God files grow one "small, related" addition at a time; stopping them at
authoring time is far cheaper than at review. A single canonical policy stops the
same rules drifting across per-language instruction files.

## Rejected alternatives

- **Line count as the goal.** A 1,000-line pure data/schema table can be fine; a
  300-line file with eight responsibilities is not.
- **Restating the full policy in each instruction file.** Duplication that
  drifts — the exact failure this ADR centralises.
