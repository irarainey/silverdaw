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

Follow **ADR 0016** (`docs/adr/0016-maintainability-file-size.md`) for the full
gate — single-responsibility / domain separation, the "Before you add code"
authoring check, split mechanics, and the ~800-line hard trigger. TS specifics:

- Soft ceiling **~350 lines** per module; pure type/schema-only files may run
  longer. Extract pure helpers and sub-modules early from large Pinia stores and
  composables (e.g. resist growing `projectStore.ts`, `libraryStore.ts`).
- One domain per module (clips, tracks, markers, transitions, library,
  persistence, transport, …); cross-domain coupling is a small explicit contract.
- Split the bridge schema by domain under `shared/bridge/*`, re-exported from the
  `bridge-protocol.ts` facade — never fork a parallel hand-written type.
- Extract via pure mechanical moves; keep `pnpm typecheck` / `lint` / `test`
  green at each step.

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

Follow **ADR 0014** (`docs/adr/0014-testing-strategy.md`): use the project's
framework (Vitest) and naming style, expand integration coverage when behaviour
crosses modules, run targeted specs for quick feedback, and avoid brittle timing
assertions (prefer fake timers or injected clocks).

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
