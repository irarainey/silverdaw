// Outbound envelope validation for the bridge.
//
// Guards the send boundary so a buggy local callsite can never put a malformed
// `{ type, payload }` frame on the wire. Structural only: it checks the type is
// known and that the payload presence/shape matches the catalogue's declared
// kind. Deep field validation stays on the backend (the trust boundary, via the
// strict `PayloadHelpers` readers); the `bridgeOutboundPayloadKinds` registry in
// `@shared/bridge-protocol` is the single source of truth this mirrors.

import {
  bridgeOutboundPayloadKinds,
  isBridgeOutboundType,
  type BridgeOutboundType
} from '@shared/bridge-protocol'

export type OutboundValidation = { ok: true } | { ok: false; reason: string }

/** True for a plain JSON object payload (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate an outbound envelope before it is serialised. Returns `{ ok: true }`
 * for a well-formed frame, or `{ ok: false, reason }` describing the structural
 * mismatch so the caller can drop and log it.
 */
export function validateOutboundEnvelope(type: unknown, payload: unknown): OutboundValidation {
  if (!isBridgeOutboundType(type)) {
    return { ok: false, reason: `unknown outbound type ${String(type)}` }
  }
  const kind = bridgeOutboundPayloadKinds[type as BridgeOutboundType]
  if (kind === 'none') {
    return payload === undefined
      ? { ok: true }
      : { ok: false, reason: `type ${type} takes no payload` }
  }
  if (payload === undefined) {
    return { ok: false, reason: `type ${type} requires a payload` }
  }
  if (!isPlainObject(payload)) {
    return { ok: false, reason: `type ${type} payload must be an object` }
  }
  return { ok: true }
}
