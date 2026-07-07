# ADR 0004 — zod schema is the single source of truth for the wire protocol

- **Date:** 2026-05-15 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

`frontend/src/shared/bridge-protocol.ts` is the canonical wire-protocol
contract — a stable **facade** that re-exports the real schema modules
`shared/bridge/inbound.ts` and `shared/bridge/outbound.ts` (edit those, not the
facade). Inbound (backend → renderer) payloads are defined as **zod** schemas;
their TypeScript types are derived via `z.infer<>`, and each `isXxxPayload` guard
is a one-line `safeParse(value).success` wrapper. Outbound (renderer → backend)
payloads are plain TS interfaces in the same file (compile-checked at every
`send<K>()` call site). A new message is added to the schema **first**, then
validated on both ends. On the backend, inbound fields are extracted through the
strict `tryGetString`/`tryGetRequiredString`/`tryGetNumber` helpers rather than
coercing `juce::var` silently.

## Why

- A single schema that generates both the runtime guard and the static type
  cannot drift the way a hand-written parallel interface can.
- Runtime validation at the trust boundary rejects malformed frames up front.

## Rejected alternatives

- **Hand-written TS interfaces + separate runtime checks.** Two artefacts that
  silently diverge — the exact failure mode this avoids.
- **No runtime validation (types only).** Types vanish at runtime; a malformed or
  hostile frame would flow straight into handlers.
