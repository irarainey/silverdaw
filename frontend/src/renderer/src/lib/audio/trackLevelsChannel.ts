// Latest per-track output peaks delivered by the backend's
// `TRACK_LEVELS` envelope (~60 Hz while audio is active). Same design
// rationale as `masterLevelChannel`: deliberately kept out of Pinia
// so the per-track meter components can poll their level on a single
// shared RAF tick without triggering Vue reactivity on every update.
//
// Values are linear sample magnitudes (post per-track chain). They
// can exceed 1.0 when summed clips run hot — the meter is responsible
// for the dB conversion and any over-zero clip indicator.

interface TrackLevel {
  peakL: number
  peakR: number
  lastUpdateMs: number
}

// Plain object map (no reactivity). Reads/writes are O(1) by trackId.
const levels: Record<string, TrackLevel> = Object.create(null)
let lastBroadcastAtMs = 0

/** Called by `bridgeService` on every inbound `TRACK_LEVELS` envelope.
 *  Tracks absent from `entries` are NOT cleared — the backend gates
 *  emission on signal, so a track that just went quiet still appears
 *  with peakL=peakR=0 on the trailing zero-emission broadcast; if it
 *  drops out entirely (e.g. last clip removed) we want its stored
 *  value to decay naturally via `readTrackLevels` returning the last
 *  known value rather than snapping to 0. `clearTrackLevels()` on
 *  bridge disconnect handles the lifecycle reset. */
export function setTrackLevels(
  entries: ReadonlyArray<{ id: string; peakL: number; peakR: number }>
): void {
  const now = performance.now()
  lastBroadcastAtMs = now
  for (const e of entries) {
    levels[e.id] = { peakL: e.peakL, peakR: e.peakR, lastUpdateMs: now }
  }
}

/** Snapshot for one track's meter RAF redraw. Returns zeros if the
 *  backend has never reported peaks for this id (empty track, or
 *  newly created). Cheap — single object lookup + three field reads. */
export function readTrackLevels(trackId: string): TrackLevel {
  const v = levels[trackId]
  if (v === undefined) return { peakL: 0, peakR: 0, lastUpdateMs: 0 }
  return v
}

/** Timestamp of the most recent `TRACK_LEVELS` broadcast (any track).
 *  Used to drive a single shared RAF loop on the renderer side. */
export function lastTrackLevelsBroadcastAtMs(): number {
  return lastBroadcastAtMs
}

/** Reset on bridge disconnect — a stale "max ever" would otherwise
 *  linger on the meters of any track that played before the drop. */
export function clearTrackLevels(): void {
  for (const k of Object.keys(levels)) delete levels[k]
  lastBroadcastAtMs = 0
}

/** Drop a single track's stored peaks — used when a track is removed
 *  on the renderer so a newly-created track at the same UI slot
 *  doesn't inherit the previous occupant's residual meter. */
export function clearTrackLevel(trackId: string): void {
  delete levels[trackId]
}
