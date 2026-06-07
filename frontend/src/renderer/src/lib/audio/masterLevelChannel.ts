// Latest master output peaks from the backend's `MASTER_LEVEL` envelope
// (~60 Hz). Plain module state, NOT a Pinia store: the meter is the only
// consumer and renders via requestAnimationFrame, so reactivity would only add
// wasteful per-tick re-renders. Values are linear magnitudes (post master gain)
// and can exceed 1.0; the meter converts to dB and shows any clip indicator.

let peakL = 0
let peakR = 0
let lastUpdateMs = 0

/** Called by `bridgeService` on every inbound `MASTER_LEVEL` envelope. */
export function setMasterLevels(l: number, r: number): void {
  peakL = l
  peakR = r
  lastUpdateMs = performance.now()
}

/** Snapshot for the meter's RAF redraw. Cheap — three field reads. */
export function readMasterLevels(): {
  peakL: number
  peakR: number
  lastUpdateMs: number
} {
  return { peakL, peakR, lastUpdateMs }
}

/** Reset on bridge disconnect so a stale "max ever" doesn't linger. */
export function clearMasterLevels(): void {
  peakL = 0
  peakR = 0
  lastUpdateMs = 0
}
