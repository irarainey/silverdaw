# ADR 0012 — UI/UX design-system conventions

- **Date:** 2026-05-31 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `IMPORTANT`

## Decision

The renderer is **dark, flat, dense, and keyboard-friendly**, built from a
tightly-scoped visual language:

- **One neutral ramp (`zinc`) + one interactive accent (`sky`) + a small fixed
  severity set (`emerald`/`amber`/`red`).** No other palettes.
- **Reuse shared primitives** from `renderer/src/assets/style.css` (`.dialog-*`,
  the shared button classes). Change a visual globally by editing `style.css`
  once; do not override per component; promote a repeated pattern to a shared
  class.
- **Never use the default browser focus ring.** Indicate focus by recolouring
  the border to the accent (`focus:border-sky-500`). In Electron the default
  ring is a jarring white/orange outline — treat it as a bug.
- **Inline/contextual over modal** (see ADR 0011).
- **Familiar, DAW-standard user-facing terms** (Reverb, Delay, Pan, Compressor);
  Title Case for controls, sentence case for body, `…` on actions that open
  further input. Internal names may differ (e.g. the UI "Compressor" is the
  `Leveler` DSP class) but the UI wording stays consistent everywhere.

The detailed tokens, component classes, and patterns are the load-on-demand
reference in `.github/instructions/ui-ux-styling.instructions.md`.

## Why

A single, small visual language keeps a dense DAW UI coherent and fast to build,
and prevents palette/component sprawl as features accrete. Deliberate focus
styling avoids the inconsistent Electron default ring.

## Rejected alternatives

- **Ad-hoc per-component styling / multiple palettes.** Guarantees visual drift.
- **Default browser focus rings.** Inconsistent and visually broken in Electron.
- **Over-technical DSP jargon in the UI.** Alienates the target audience (ADR 0011).
