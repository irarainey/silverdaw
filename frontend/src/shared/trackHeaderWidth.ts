// Seven 24px buttons, six 4px gaps, 8px padding and a 2px selected border per side.
export const MIN_TRACK_HEADER_WIDTH = 7 * 24 + 6 * 4 + 2 * (8 + 2)

export function clampTrackHeaderWidth(value: unknown, fallback = MIN_TRACK_HEADER_WIDTH): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(Math.max(MIN_TRACK_HEADER_WIDTH, Math.min(480, value)))
}
