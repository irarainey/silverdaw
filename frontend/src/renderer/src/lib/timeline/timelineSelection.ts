export interface TimelineSelection {
  startMs: number
  endMs: number
}

/** Returns one non-empty, ascending timeline range or null for an invalid drag. */
export function normaliseTimelineSelection(
  firstMs: number,
  secondMs: number
): TimelineSelection | null {
  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) return null
  const startMs = Math.min(firstMs, secondMs)
  const endMs = Math.max(firstMs, secondMs)
  return endMs > startMs ? { startMs, endMs } : null
}
