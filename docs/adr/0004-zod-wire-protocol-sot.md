# ADR 0004 — zod schema is the single source of truth for the wire protocol

- **Date:** 2026-05-15 · **Status:** Accepted · **Owner:** @irarainey · **Importance:** `CRITICAL`

## Decision

`frontend/src/shared/bridge-protocol.ts` is the canonical wire-protocol
contract — a stable **facade** over the message maps and domain modules in
`frontend/src/shared/bridge/`. Inbound (backend → renderer) payloads use
**zod** schemas for runtime validation and `z.infer<>` for static types.
The outbound map type-checks each `send<K>()` call. Many outbound entries are
plain TS interfaces; others use types inferred from domain schemas, including
`TRACK_EXPORT_START` in `trackExport.ts`. Add a new message to the contract
**first**, then validate it on both ends. On the backend, fields are read with the
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
