---
description: "Guidelines for TypeScript Development targeting TypeScript 5.x and ES2022 output"
applyTo: "**/*.ts"
---

# TypeScript Development

> These instructions assume projects are built with TypeScript 5.x (or newer) compiling to an ES2022 JavaScript baseline. Adjust guidance if your runtime requires older language targets or down-level transpilation.

## Core Intent

- Respect the existing architecture and coding standards.
- Prefer readable, explicit solutions over clever shortcuts.
- Extend current abstractions before inventing new ones.
- Prioritize maintainability and clarity, short methods and classes, clean code.

## General Guardrails

- Target TypeScript 5.x / ES2022 and prefer native features over polyfills.
- Use pure ES modules; never emit `require`, `module.exports`, or CommonJS helpers.
- Rely on the project's build, lint, and test scripts unless asked otherwise.
- Note design trade-offs when intent is not obvious.

## Project Organization

- Follow the repository's folder and responsibility layout for new code.
- Use kebab-case filenames (e.g., `user-session.ts`, `data-service.ts`) unless told otherwise.
- Keep tests, types, and helpers near their implementation when it aids discovery.
- Reuse or extend shared utilities before adding new ones.

## File Size and Single Responsibility

- **Default to domain separation of logic.** Organise code by the feature /
  problem domain it serves (clips, tracks, markers, transitions, library,
  persistence, transport, …), not by incidental technical layering. New logic
  goes into the module that owns its domain; when a file mixes domains, that is
  the first and strongest seam to split along. Approach every change — new or
  refactor — by asking "which domain owns this?" before "where is there room to
  put it?". Cross-domain coupling should be a small, explicit contract (a shared
  `this`/interface type, a narrow imported helper), never a tangle of reach-ins.
- **Each domain of logic lives in its own file — always, by default.** This is a
  standing rule, not an aspiration. A distinct feature/problem domain (a clip
  concern, a track concern, a persistence concern, a transport concern, …) gets
  its own dedicated module rather than being co-located with unrelated domains in
  a shared file. Start domains separated — do not bundle two of them into one
  file "for convenience", because they feel related, or because each is currently
  small; "related" and "only a few lines" are never sufficient reasons. The
  *only* grounds for keeping multiple domains in one file is an **exceptionally
  good, explicitly documented** reason — e.g. they are genuinely one inseparable
  unit, or splitting would force an unavoidable circular dependency that no shared
  contract type can break. When you do keep them together, record that reason in
  the file and re-evaluate it on every change; the moment the justification
  weakens, split. This rule is independent of line count: a 120-line file mixing
  two domains is still wrong even though it is far below any ceiling.
- A module should be one coherent unit of thought; if you can't describe it in
  one short sentence, split it. Line count is a *symptom, not the goal*.
- Soft ceilings (scrutinise above): TS module ~350 lines; Pinia store actions /
  large composables, extract pure helpers and sub-modules early. Pure
  type/schema-only files may run longer.
- **Treat ~800 lines as a firm ceiling, not a suggestion.** Aim well below it.
  A file approaching ~800 lines is a strong signal to split *now*, before it
  grows further; a file over ~800 lines is a defect to fix, not a style nit.
- **Nothing is impossible — exhaust every avenue before keeping a file oversized.**
  A standing "justified exception" is the last resort, never the first answer.
  If you reach for one, you must show you genuinely explored splitting by domain,
  by responsibility, by adapter, and by extracting pure helpers — and record why
  each was rejected. A previously-recorded exception is **not** a permanent
  licence: re-evaluate it every time the file grows or a feature lands.
- **Earlier architectural decisions are always revisable.** As the codebase
  grows, a module layout or boundary that was once reasonable (including a file
  that was previously a "justified" large file) may no longer be the cleanest.
  Treat the existing structure as provisional: when a file crosses the ceiling,
  actively reconsider whether the original decomposition still holds and
  re-split by domain / responsibility — e.g. spread focused action modules into
  a store, lift cross-references into a small shared `this`/contract type —
  rather than defending the status quo. Prefer revising the structure over
  declaring an exception. Refactors that move boundaries are expected, normal
  iterative work, not a special event.
- **A split must still genuinely improve maintainability**, not just move lines.
  A contrived extraction — a composable taking a large cross-cutting "dependency
  bag", or fragmenting one coherent unit of thought into arbitrary part1/part2
  files — is not progress. But this is a quality bar for *how* you split, not an
  excuse to skip splitting: first find the real domain seams (they almost always
  exist), and only fall back to a recorded exception once those are genuinely
  exhausted.
- **Resist growing an already-oversized file** (e.g. `projectStore.ts`,
  `bridge-protocol.ts`, `libraryStore.ts`) — extract a focused module instead,
  even for a small addition.
- Prefer a stable **barrel / facade re-export** so existing importers don't
  churn when you split a module. Extract via pure mechanical moves (no behaviour
  change) and keep `pnpm typecheck` / `lint` / `test` green at each step.
- For the bridge schema, split by domain into `shared/protocol/*` re-exported
  from the existing `bridge-protocol.ts` facade — it stays the single source of
  truth; never fork a parallel hand-written type.

## Naming & Style

- Use PascalCase for classes, interfaces, enums, and type aliases; camelCase for everything else.
- Skip interface prefixes like `I`; rely on descriptive names.
- Name things for their behavior or domain meaning, not implementation.

## Formatting & Style

- Run the repository's lint/format scripts (this repo uses **pnpm**, never `npm` — e.g., `pnpm run lint`) after making changes and fix any issues that arise.
- Match the project's indentation, quote style, and trailing comma rules.
- Keep functions focused; extract helpers when logic branches grow.
- Favor immutable data and pure functions when practical.

## Type System Expectations

- Avoid `any` (implicit or explicit); prefer `unknown` plus narrowing.
- Use discriminated unions for realtime events and state machines.
- Centralize shared contracts instead of duplicating shapes.
- Express intent with TypeScript utility types (e.g., `Readonly`, `Partial`, `Record`).

## Async, Events & Error Handling

- Use `async/await`; wrap awaits in try/catch with structured errors.
- Guard edge cases early to avoid deep nesting.
- Send errors through the project's logging/telemetry utilities.
- Surface user-facing errors via the repository's notification pattern.
- Debounce configuration-driven updates and dispose resources deterministically.

## Architecture & Patterns

- Follow the repository's dependency injection or composition pattern; keep modules single-purpose.
- Observe existing initialization and disposal sequences when wiring into lifecycles.
- Keep transport, domain, and presentation layers decoupled with clear interfaces.
- Supply lifecycle hooks (e.g., `initialize`, `dispose`) and targeted tests when adding services.

## External Integrations

- Instantiate clients outside hot paths and inject them for testability.
- Never hardcode secrets; load them from secure sources.
- Apply retries, backoff, and cancellation to network or IO calls.
- Normalize external responses and map errors to domain shapes.

## Security Practices

- Validate and sanitize external input with schema validators or type guards.
- Avoid dynamic code execution and untrusted template rendering.
- Encode untrusted content before rendering HTML; use framework escaping or trusted types.
- Use parameterized queries or prepared statements to block injection.
- Keep secrets in secure storage, rotate them regularly, and request least-privilege scopes.
- Favor immutable flows and defensive copies for sensitive data.
- Use vetted crypto libraries only.
- Patch dependencies promptly and monitor advisories.

## Configuration & Secrets

- Reach configuration through shared helpers and validate with schemas or dedicated validators.
- Handle secrets via the project's secure storage; guard `undefined` and error states.
- Document new configuration keys and update related tests.

## UI & UX Components

- Sanitize user or external content before rendering.
- Keep UI layers thin; push heavy logic to services or state managers.
- Use messaging or events to decouple UI from business logic.

## Testing Expectations

- Add or update unit tests with the project's framework and naming style.
- Expand integration or end-to-end suites when behavior crosses modules or platform APIs.
- Run targeted test scripts for quick feedback before submitting.
- Avoid brittle timing assertions; prefer fake timers or injected clocks.

## Performance & Reliability

- Lazy-load heavy dependencies and dispose them when done.
- Defer expensive work until users need it.
- Batch or debounce high-frequency events to reduce thrash.
- Track resource lifetimes to prevent leaks.

## Documentation & Comments

- Keep comments short and minimal — one line wherever possible. Default to no
  comment; add one only when the code's intent is genuinely non-obvious.
- Comment the *why*, never the *what*; never restate the code, and avoid
  verbose or multi-paragraph comment blocks.
- Prioritise documentation over comments: put substantial rationale, design,
  or API detail in `docs/` rather than long inline comments or sprawling JSDoc.
- Add JSDoc to public APIs, but keep it concise; reserve `@remarks`/`@example`
  for genuinely non-obvious cases.
- When editing existing comments, condense them and remove stale notes during
  refactors — do not let comments grow.
- Update architecture or design docs when introducing significant patterns.
