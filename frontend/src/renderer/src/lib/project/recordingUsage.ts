interface Range {
  startMs: number
  endMs: number
}

interface ReportUse extends Range {
  originalRange?: Range
  originalWindow?: Range
  excluded?: string
  fileType: string
}

function mergedRanges(ranges: Range[]): Range[] {
  const merged: Range[] = []
  for (const range of ranges.sort((a, b) => a.startMs - b.startMs)) {
    if (range.endMs <= range.startMs) continue
    const last = merged.at(-1)
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs)
    else merged.push({ startMs: range.startMs, endMs: range.endMs })
  }
  return merged
}

function totalDuration(ranges: Range[]): number {
  return ranges.reduce((total, r) => total + (r.endMs - r.startMs), 0)
}

export function recordingUsage(files: { placements: ReportUse[] }[]) {
  const placements = files.flatMap(file => file.placements)
  const known = placements.flatMap(use => use.originalRange ? [use.originalRange] : [])
  const included = placements.filter(use => !use.excluded)
  const windowOnly = placements.filter(use => use.originalWindow).length
  const passages = mergedRanges(known)
  return {
    placements: placements.length,
    stems: files.filter(file => file.placements.some(use => use.fileType === 'Stem')).length,
    passages: passages.length,
    knownOriginalMs: passages.length ? totalDuration(passages) : undefined,
    windowOnly,
    unmapped: placements.length - known.length - windowOnly,
    arrangedMs: totalDuration(mergedRanges(placements)),
    includedMs: totalDuration(mergedRanges(included)),
    excluded: placements.length - included.length
  }
}
