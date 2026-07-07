# ADR 0010 — Licence: AGPL-3.0-or-later

- **Date:** 2026-05-17 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

Silverdaw is released under **GNU AGPL-3.0-or-later**. Every new dependency or
vendored component must be licence-compatible, and its terms recorded in
`THIRD_PARTY_LICENSES.md`.

## Why

- Strong copyleft keeps the project and its derivatives open.
- A single, stated licence gate makes dependency decisions unambiguous — an
  incompatible library is rejected before it is adopted, not discovered later.

## Rejected alternatives

- **Permissive (MIT/Apache).** Allows closed forks; not the intent for this
  project.
- **Plain GPL-3.0.** AGPL's network clause is preferred to keep any hosted
  derivative open too.
