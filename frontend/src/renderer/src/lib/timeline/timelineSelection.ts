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

/** Retain only the selectable part of a range after the project becomes shorter. */
export function clampTimelineSelectionToDuration(
  selection: TimelineSelection | null,
  durationMs: number
): TimelineSelection | null {
  if (selection === null) return null
  if (!Number.isFinite(durationMs) || durationMs <= selection.startMs) return null
  if (selection.endMs <= durationMs) return selection
  return { startMs: selection.startMs, endMs: durationMs }
}
