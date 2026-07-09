# Decision Index — Silverdaw

One line per decision. Linked from `CONTEXT.md` and read when relevant; each
linked ADR under `docs/adr/` holds the reasoning and rejected alternatives and is
read only when a task touches that decision. Write the ADR at the moment of
decision and add its line here.

| ID | Importance | Decision | Record |
| --- | --- | --- | --- |
| D-0001 | `CRITICAL` | Two-process split: Electron UI + headless JUCE engine | `docs/adr/0001-two-process-split.md` |
| D-0002 | `CRITICAL` | Backend `ValueTree` is the single source of truth for project state | `docs/adr/0002-valuetree-source-of-truth.md` |
| D-0003 | `CRITICAL` | Text-only bridge; bulk data via disk | `docs/adr/0003-text-only-bridge.md` |
| D-0004 | `CRITICAL` | zod schema is the single source of truth for the wire protocol | `docs/adr/0004-zod-wire-protocol-sot.md` |
| D-0005 | `CRITICAL` | Dynamic loopback port + per-session AUTH token | `docs/adr/0005-dynamic-port-auth.md` |
| D-0006 | `CRITICAL` | Real-time audio thread: lock-free, no allocation | `docs/adr/0006-realtime-audio-thread.md` |
| D-0007 | `CRITICAL` | Non-destructive editing (settings on clips, never mutate source) | `docs/adr/0007-non-destructive-editing.md` |
| D-0008 | `IMPORTANT` | Out-of-process engine resilience and recovery | `docs/adr/0008-engine-resilience.md` |
| D-0009 | `IMPORTANT` | Stem separation via ONNX Runtime (RoFormer + htdemucs backup) | `docs/adr/0009-stem-separation-onnx.md` |
| D-0010 | `IMPORTANT` | Licence: AGPL-3.0-or-later | `docs/adr/0010-licence-agpl.md` |
| D-0011 | `IMPORTANT` | Product ethos: radical beginner-first simplicity | `docs/adr/0011-product-ethos-simplicity.md` |
| D-0012 | `CRITICAL` | UI/UX design-system conventions | `docs/adr/0012-ui-ux-design-system.md` |
| D-0013 | `IMPORTANT` | Frontend stack: Vue 3 + Pinia + PixiJS + Tailwind | `docs/adr/0013-frontend-stack.md` |
| D-0014 | `IMPORTANT` | Testing strategy (custom backend harness + Vitest) | `docs/adr/0014-testing-strategy.md` |
| D-0015 | `IMPORTANT` | Project file format: versioned JSON | `docs/adr/0015-project-file-format.md` |
| D-0016 | `CRITICAL` | Maintainability & file-size policy | `docs/adr/0016-maintainability-file-size.md` |
| D-0017 | `IMPORTANT` | Performance priorities: audio playback is first-class | `docs/adr/0017-performance-priorities.md` |
| D-0018 | `IMPORTANT` | Autosave-backed crash recovery | `docs/adr/0018-autosave-crash-recovery.md` |
| D-0019 | `CRITICAL` | Backward compatibility for a released product (versioned, read-old/write-latest) | `docs/adr/0019-backward-compatibility-released-product.md` |
