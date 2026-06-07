// Pure musical-time helpers shared by transport, timeline grid and tests.

export const DEFAULT_SUBS_PER_BEAT = 4
export const DEFAULT_BEATS_PER_BAR = 4

/** Milliseconds per sub-beat; clamps BPM to avoid infinite timeline geometry. */
export function msPerSubBeat(bpm: number, subsPerBeat: number = DEFAULT_SUBS_PER_BEAT): number {
  return 60000 / (Math.max(1, bpm) * subsPerBeat)
}

export interface BarPositionOptions {
  subsPerBeat?: number
  beatsPerBar?: number
}

/** Format as 0-indexed `Bar.Beat.Sub` using integer sub-beats to avoid drift. */
export function barPositionDisplay(
  positionMs: number,
  bpm: number,
  options: BarPositionOptions = {}
): string {
  const subsPerBeat = options.subsPerBeat ?? DEFAULT_SUBS_PER_BEAT
  const beatsPerBar = options.beatsPerBar ?? DEFAULT_BEATS_PER_BAR
  const subsPerBar = subsPerBeat * beatsPerBar
  const msPerSub = msPerSubBeat(bpm, subsPerBeat)
  const totalSubs = Math.max(0, Math.round(positionMs / msPerSub))
  const bar = Math.floor(totalSubs / subsPerBar)
  const subsInBar = totalSubs % subsPerBar
  const beatInBar = Math.floor(subsInBar / subsPerBeat)
  const subInBeat = subsInBar % subsPerBeat
  return `${bar}.${beatInBar}.${subInBeat}`
}

/** Format milliseconds as `mm:ss` or `h:mm:ss`, clamping negatives to zero. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Parse `ss`, `mm:ss` or `h:mm:ss` into milliseconds; malformed input returns `null`. */
export function parseTime(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const parts = trimmed.split(':').map((p) => p.trim())
  if (parts.length > 3) return null
  for (const p of parts) {
    if (p === '' || Number.isNaN(Number(p))) return null
  }
  let h = 0
  let m = 0
  let s = 0
  if (parts.length === 1) {
    s = Number(parts[0])
  } else if (parts.length === 2) {
    m = Number(parts[0])
    s = Number(parts[1])
  } else {
    h = Number(parts[0])
    m = Number(parts[1])
    s = Number(parts[2])
  }
  if (h < 0 || m < 0 || s < 0) return null
  return Math.round((h * 3600 + m * 60 + s) * 1000)
}
