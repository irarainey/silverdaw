---
mode: agent
description: "Full-monorepo, no-interaction review of Silverdaw (C++/JUCE backend + TypeScript/Vue 3 Electron frontend) against the project's standards."
---

# Codebase Review — Silverdaw (whole-monorepo, one-shot)

You are a senior staff engineer in **NO-INTERACTION MODE**. Review the entire
Silverdaw monorepo in one pass and return all deliverables without asking
questions; state any assumptions explicitly.

This prompt is the **deliberate full-repo sweep**. For scoped or interactive
review of a single change, subsystem, or PR, use the **Code Reviewer** agent
(`.github/chatmodes/code-reviewer.chatmode.md`) instead.

## Standards (single source of truth — do not restate, apply them)

- `.github/copilot-instructions.md` — review priorities, the maintainability
  rules (file size, duplication, SRP, best practice), and the hard project
  invariants (audio-thread real-time safety, `{ type, payload }` bridge contract
  via the zod schema, dynamic `--port` bridge, Electron hardening, strict types,
  non-destructive editing, the custom `SilverdawBackendTests` harness).
- `.github/instructions/*.instructions.md` — the path-specific C++/JUCE,
  TypeScript, audio-waveform TS, Vue 3, Markdown, and documentation contracts.
- Where these are silent, defer to ISO C++17 / C++ Core Guidelines / CERT C++,
  the Vue Style Guide, the Electron security checklist, and OWASP Top 10.

Priorities: **correctness > maintainability / best practice > security >
performance > micro-optimisation**. Lead with maintainability — oversized files,
duplication, and SRP violations are blocking-class findings, each reported with a
concrete split or single-source-of-truth proposal. If a tool (`clang-tidy`,
`eslint`, `vue-tsc`, `cmake`, `ctest`) can't run in this session, emulate its
checks analytically and proceed.

## Review plan (execute end-to-end, both surfaces + the bridge)

1. **Inventory** — modules, public surface, ownership, coupling, hot paths,
   threading model; map every bridge `type` and its direction.
2. **Maintainability sweep (primary)** — oversized files and god objects (propose
   splits), duplicated logic/dispatch/shapes/constants (propose dedupes), SRP and
   layer-boundary violations, magic numbers, over-complex functions.
3. **Standards & style** — apply the instruction files (C++ RAII/ownership/
   `const`/`[[nodiscard]]`/JUCE conventions; TS/Vue `<script setup lang="ts">`,
   no `any`, discriminated unions, Pinia by domain, kebab-case files). Remove
   dead/commented code, stray `console.*` / `std::cout`, orphan IPC handlers.
4. **Correctness & robustness** — edge cases, error propagation, exception/RAII
   safety, exhaustive union narrowing, deterministic teardown.
5. **Threading** — audio thread does no allocation/locking/throwing/blocking I/O;
   lock-free hand-off; no races / use-after-free across threads.
6. **Types & contracts** — strengthen end-to-end; backend validates `juce::var`
   shapes; preload `contextBridge` surface matches renderer ambient types.
7. **Security** — Electron hardening, validated IPC, path traversal on import,
   untrusted `data:` URIs, unbounded buffers, sample-count overflow, loopback-only
   bridge, dependency audit.
8. **Performance** — algorithmic hotspots, N+1 IPC, reactivity churn, PixiJS
   object churn, audio-thread allocations, `juce::String` copies, JSON re-parses.
9. **Tests** — coverage gaps; propose tests against the existing harnesses only
   (`SilverdawBackendTests` via CTest; Vitest; Playwright e2e).
10. **Observability, docs & tooling** — logging consistency, structured bridge
    error events, README/build accuracy, `.clang-tidy` / ESLint / tsconfig /
    CMake / scripts hygiene. Enforce the no-other-DAW-product rule in all docs.

## Rubber-duck critique (required)

Before finalising, run an adversarial critique of the major/critical findings and
of any proposed patch touching real-time audio, Electron IPC, the bridge
contract, persistence/recovery, or timeline rendering. All serious review work
**must** be rubber-ducked across **three models**: the model running the review
(**opus-4.8**), **gpt-5.5**, and **gpt-5.3-codex**. If any of the three is
genuinely unavailable, explicitly note which one and complete the critique with
the rest. Reconcile any disagreement between the models, then include a short
**Rubber-duck validation** note (which three perspectives were consulted, what
changed, any unresolved disagreement).

## Output

1. **Executive Summary** (≤200 words) — quality, key risks, expected outcomes;
   backend vs frontend vs bridge called out separately when they differ.
2. **Maintainability scorecard** — file size & boundaries, duplication, and
   best-practice/SRP, each ✅ / ⚠️ / ❌ per surface with a one-line rationale.
3. **Findings** — grouped by severity (critical → minor), each with
   `surface · file:line`, evidence, why it matters, and a concrete recommendation.
4. **Split / dedupe plan** — every oversized file and duplication with its
   concrete extraction / single-source-of-truth target.
5. **Patches** — up to 3 minimal, behaviour-preserving ` ```diff ` blocks.
6. **Next actions** — _quick wins_ (≤30 min) · _targeted fixes_ (one PR each) ·
   _structural_ (multi-PR).

## Guardrails

- No questions back to the user; state assumptions explicitly.
- Do not invent behaviour beyond evidence in code; flag uncertainties plainly.
- Prefer minimal, safe changes; larger rewrites only for correctness, security,
  or threading-invariant issues.
- Respect the existing architecture and conventions; extend before inventing.
- Never recommend suppressing a lint rule without a one-line justification.
