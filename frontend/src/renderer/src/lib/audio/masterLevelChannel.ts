// Latest master output peaks delivered by the backend's `MASTER_LEVEL`
// envelope (~60 Hz while audio is active). Stored as plain module
// state — deliberately NOT a Pinia store — because the meter is the
// only consumer and its rendering is driven by a `requestAnimationFrame`
// loop rather than Vue reactivity. Putting these on a reactive store
// would trigger re-renders on every tick for every subscriber across
// the app, which is wasteful when the meter is the sole reader.
//
// Values are linear sample magnitudes (post master gain). They can
// exceed 1.0 when tracks sum hot — the meter is responsible for
// converting to dB and rendering any over-zero "clip" indicator.

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
