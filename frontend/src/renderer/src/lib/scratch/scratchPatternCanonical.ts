// Deterministic canonical serialization of a ScratchPattern for content-based
// dirty detection and save acknowledgement comparison. Produces a stable string
// representation so that two patterns with identical content always yield the
// same canonical form regardless of property insertion order.

import type { ScratchPattern } from '@shared/bridge-protocol'

/**
 * Produce a deterministic canonical string for a ScratchPattern.
 * Used as a baseline for dirty detection: two patterns are "content-equal"
 * iff their canonical forms are identical strings.
 *
 * The serialization is ordered by field name to guarantee stability across
 * JS engine property-order variations and backend round-trips.
 */
export function canonicalizeScratchPattern(pattern: ScratchPattern): string {
  // Build a deterministic representation with explicit field ordering.
  // JSON.stringify with a sorted-keys replacer is not sufficient because
  // nested arrays must preserve element order. We use a fixed field order.
  const canonical = {
    id: pattern.id,
    name: pattern.name,
    version: pattern.version,
    durationUs: pattern.durationUs,
    cropStartUs: pattern.cropStartUs,
    cropEndUs: pattern.cropEndUs,
    sourceOffsetTurns: pattern.sourceOffsetTurns,
    ownerDeck: pattern.ownerDeck,
    crossfaderCurve: pattern.crossfaderCurve,
    platter: pattern.platter.map((kf) => ({
      timeUs: kf.timeUs,
      turns: kf.turns,
      touched: kf.touched
    })),
    crossfader: pattern.crossfader.map((kf) => ({
      timeUs: kf.timeUs,
      value: kf.value
    })),
    provenance: pattern.provenance
      ? {
          sourceClipId: pattern.provenance.sourceClipId,
          ...(pattern.provenance.sourceLibraryItemId !== undefined
            ? { sourceLibraryItemId: pattern.provenance.sourceLibraryItemId }
            : {})
        }
      : undefined
  }

  return JSON.stringify(canonical)
}
