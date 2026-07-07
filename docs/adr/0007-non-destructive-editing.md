# ADR 0007 — Non-destructive editing

- **Date:** 2026-05-14 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

Editing never mutates the user's source files. Tempo/warp, pitch, trim, fades,
reverse, volume-shape envelopes, and gain are stored as **clip settings** in the
project model and applied at playback and mixdown time. Clips are non-destructive
source windows referencing a `libraryItemId`; the source file is only ever read.

## Why

- Users import their own music; silently rewriting it is unacceptable and
  unrecoverable.
- Settings-as-data makes every edit reversible (undo), re-editable, and cheap to
  serialise, and keeps playback and mixdown reading the same canonical chain.

## Rejected alternatives

- **Destructive/rendered edits.** Faster to play back but throws away the
  original and every future re-edit; contradicts the remix/mashup workflow where
  users iterate constantly.
