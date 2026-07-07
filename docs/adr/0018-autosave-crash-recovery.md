# ADR 0018 — Autosave-backed crash recovery

- **Date:** 2026-05-21 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

Crash recovery is built on periodic **autosave snapshots**, not journaling or an
OS-level mechanism:

- While a project is dirty it is silently snapshotted every N seconds (default
  30 s, configurable in Preferences ▸ Project ▸ Autosave, clamped 5–600 s) into
  `%APPDATA%/Silverdaw/autosave/<projectId>/`, plus a final flush on `before-quit`.
- On launch, `RecoveryDialog` offers to restore any project whose autosave is
  newer than its backing file (or whose backing file is missing/untitled).
  Restoring loads the autosave and marks the project **dirty**, so the user must
  explicitly Save.
- A conscious discard ("Don't save" in the unsaved-changes prompt) clears that
  project's autosave bucket before exit, so a deliberate discard is never
  resurrected as recovery.

Per-`projectId` buckets are what the mid-session recovery coordinator (ADR 0008)
matches against when reloading into a freshly respawned engine. Full detail:
`docs/developer-guide.md` autosave section and `docs/development-plan.md` →
Auto-save & recovery.

## Why

- Reuses the versioned-JSON save path (ADR 0015) as the snapshot format — no
  separate persistence mechanism to maintain.
- Per-`projectId` buckets give the recovery coordinator (ADR 0008) an exact
  snapshot to restore after an engine respawn.
- "Newer-than-backing-file" + mark-dirty keeps the user in explicit control;
  nothing is silently overwritten, and a deliberate discard is honoured.

## Rejected alternatives

- **Operational journaling / change log.** Heavier; a whole-project JSON snapshot
  at a 30 s cadence is cheap enough and reuses ADR 0015.
- **No autosave (rely on manual Save).** Loses work on a crash and defeats the
  out-of-process recovery model (ADR 0008).
