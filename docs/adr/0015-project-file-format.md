# ADR 0015 — Project file format: versioned JSON

- **Date:** 2026-06-08 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

Projects are saved as `.silverdaw` — **versioned JSON** carrying a
schema-version field, produced from the backend `ValueTree` (ADR 0002) via a
ValueTree↔JSON converter. The backend **reads any older version and always
writes the latest**. A clip whose referenced source file is missing loads as an
`unresolved` clip (silent playback, greyed UI, per-clip "Locate file" re-link)
rather than failing the whole load.

## Why

- JSON is inspectable and diffable, and maps cleanly onto the `ValueTree`.
- A schema-version field gives forward/backward-compatibility headroom without
  building a migration framework up front.
- Graceful `unresolved` handling keeps a moved/renamed source file from making a
  project unopenable.

## Rejected alternatives

- **Opaque binary format.** Not inspectable and harder to evolve.
- **A full migration framework now.** YAGNI at the current rate of schema change;
  read-old/write-latest suffices.
