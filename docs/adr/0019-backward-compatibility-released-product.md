# ADR 0019 — Backward compatibility for a released product

- **Date:** 2026-07-08 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

Silverdaw is now publicly distributed via the **Microsoft Store** (auto-updating)
and real users have installations, saved **preferences**, and saved `.silverdaw`
**projects** on disk. From this point on, **backward compatibility is a binding
constraint on every change**:

- **Persisted formats are versioned and read-old / write-latest.** Both project
  files (ADR 0015) and application preferences carry an explicit schema version.
  A newer app must always open any older project or preferences file that a
  shipped version could have written; the loader merges over defaults, sanitises
  and clamps values, and never fails startup or a project open because of an
  older or partially-unknown file.
- **New settings and fields are additive with a safe default.** Adding state
  never changes how an older file loads — the missing field simply takes its
  default. Do not make a new field required for load.
- **Bump the version only when semantics change**, and write an explicit,
  per-version migration for it rather than silently reinterpreting old data.
  Reads of an older version apply the migration in memory; the next save writes
  the current version.
- **Never remove or repurpose a persisted key** while an older meaning may still
  exist on disk. Deprecate instead: keep reading the old key, map it forward,
  and stop writing it.
- **Code around changed functionality must degrade gracefully** for state
  produced by an older version — missing sub-trees, absent settings, and legacy
  enum values load as sensible defaults, never a throw or a corrupted project.
- **Autosave snapshots (ADR 0018) inherit this** because they reuse the
  versioned-JSON save path.

Because the Store ships automatic updates, a user can jump from any prior version
straight to the latest, so the guarantee is **any shipped version → latest**, not
merely N-1 → N.

## Why

- Real users now have data on disk we cannot see or reset. Breaking their
  preferences, or making a saved project unopenable, is a data-loss regression —
  the worst class of bug — and directly contradicts the non-destructive-editing
  promise (ADR 0007).
- Auto-updates remove the user's ability to stay on a compatible version, so the
  compatibility has to live in the app itself.
- ADR 0015 already chose versioned JSON with read-old / write-latest and
  forward-compatible loads. This ADR promotes that from latent "headroom" to a
  binding, release-era contract, and extends it explicitly to **preferences** and
  to the **code paths around changed features**, not just the project file.

## Rejected alternatives

- **Break formats freely and rely on users to export / re-import.** Unacceptable
  for a shipped, auto-updating product — most users never read release notes and
  cannot opt out of an update.
- **A heavyweight migration framework up front.** Still YAGNI (ADR 0015):
  per-version, additive migrations invoked on read are enough at the current rate
  of schema change. Revisit only if versioned migrations start to proliferate.
- **Version projects but leave preferences unversioned.** Preferences already
  fail safe by merging over defaults, but with no version field a future
  *semantic* change to a setting cannot be migrated cleanly. An explicit version
  closes that gap before it is needed.
