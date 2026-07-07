# ADR 0011 — Product ethos: radical beginner-first simplicity

- **Date:** 2026-05-13 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

Every feature and UI decision is governed by beginner-friendly simplicity for
the target audience — bedroom DJs, producers, and mixers, **not** audio
engineers. The guiding principles:

- **Sensible defaults, no unnecessary questions.** BPM and key are auto-detected;
  warp is applied on drop. Users adjust after the fact, not before.
- **Obvious affordances.** If a core action needs documentation, the UI failed.
- **No modal dialogs for common actions.** Prefer inline editing, contextual
  panels, and right-click menus; reserve dialogs for transactional/destructive
  flows.
- **Progressive disclosure.** Basic controls always visible; advanced options
  revealed on demand.
- **Immediate feedback** and **drag-and-drop everywhere** as the primary way to
  place and move audio.

Notation and live DJ performance are explicitly deprioritised to keep the
product focused.

## Why

Approachability is the product's differentiator. Complexity-by-default would put
it in the crowded pro-DAW space and lose the target user. This ethos is the
tie-breaker whenever a feature could be built simple or powerful.

## Rejected alternatives

- **Power-user-first density.** Maximises capability but abandons the audience.
- **Wizard/modal-driven flows.** Interrupt the fast import-to-arrangement loop.
