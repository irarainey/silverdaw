import { describe, expect, it } from 'vitest'

import { validateOutboundEnvelope } from '@/lib/bridge/outboundValidation'
import { bridgeOutboundPayloadKinds } from '@shared/bridge-protocol'

describe('validateOutboundEnvelope', () => {
  it('accepts a no-payload type with no payload', () => {
    expect(validateOutboundEnvelope('TRANSPORT_PLAY', undefined)).toEqual({ ok: true })
  })

  it('accepts a payload type with a plain object payload', () => {
    expect(validateOutboundEnvelope('CLIP_REMOVE', { clipId: 'c1' })).toEqual({ ok: true })
  })

  it('rejects an unknown type', () => {
    const result = validateOutboundEnvelope('NOT_A_REAL_TYPE', { a: 1 })
    expect(result.ok).toBe(false)
  })

  it('rejects a no-payload type that carries a payload', () => {
    const result = validateOutboundEnvelope('TRANSPORT_PLAY', { stray: true })
    expect(result.ok).toBe(false)
  })

  it('rejects a payload type with a missing payload', () => {
    const result = validateOutboundEnvelope('CLIP_REMOVE', undefined)
    expect(result.ok).toBe(false)
  })

  it('rejects a payload type with a non-object payload', () => {
    expect(validateOutboundEnvelope('CLIP_REMOVE', 'oops').ok).toBe(false)
    expect(validateOutboundEnvelope('CLIP_REMOVE', 42).ok).toBe(false)
    expect(validateOutboundEnvelope('CLIP_REMOVE', null).ok).toBe(false)
    expect(validateOutboundEnvelope('CLIP_REMOVE', [1, 2]).ok).toBe(false)
  })

  it('validates every catalogued type against its declared kind', () => {
    for (const [type, kind] of Object.entries(bridgeOutboundPayloadKinds)) {
      const sample = kind === 'none' ? undefined : { ok: true }
      expect(validateOutboundEnvelope(type, sample)).toEqual({ ok: true })
    }
  })
})
