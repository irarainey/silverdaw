// Which clip a Beat Repeat region belongs to.
//
// A region is created from a selected clip but is stored in track-beat space, so
// nothing links it back to that clip. Clips rarely start and end exactly on a beat
// (a warped clip can end a few ms past one), so a plain overlap test attributes a
// region to every clip it touches — including the previous clip whose tail runs a
// few milliseconds past the beat the region starts on.
//
// A region therefore has exactly one owner: the clip on the track it overlaps most.
// That is the clip it was created from, it is stable under a tempo change, and it
// needs no extra state in the project file.
import { effectiveClipDurationMs } from '@/lib/clip/clipTiming'
import type { BeatRepeatRegion, Clip, Track } from '@/stores/projectTypes'

export interface ClipBeatSpan {
  id: string
  startBeat: number
  endBeat: number
}

export function clipBeatSpan(clip: Clip, bpm: number): ClipBeatSpan {
  return {
    id: clip.id,
    startBeat: (clip.startMs / 60000) * bpm,
    endBeat: ((clip.startMs + effectiveClipDurationMs(clip)) / 60000) * bpm
  }
}

/** Beat spans for a track's clips, in track order (the tie-break order below). */
export function trackClipBeatSpans(
  track: Track | undefined,
  clipsById: Record<string, Clip>,
  bpm: number
): ClipBeatSpan[] {
  if (!track || !Number.isFinite(bpm) || bpm <= 0) return []
  const spans: ClipBeatSpan[] = []
  for (const clipId of track.clipIds) {
    const clip = clipsById[clipId]
    if (clip) spans.push(clipBeatSpan(clip, bpm))
  }
  return spans
}

/** The clip `region` belongs to, or null when it overlaps no clip on the track. */
export function beatRepeatOwnerClipId(
  region: Pick<BeatRepeatRegion, 'startBeat' | 'lengthBeats'>,
  spans: readonly ClipBeatSpan[]
): string | null {
  const regionEnd = region.startBeat + region.lengthBeats
  let ownerId: string | null = null
  let widest = 0
  for (const span of spans) {
    const overlap = Math.min(regionEnd, span.endBeat) - Math.max(region.startBeat, span.startBeat)
    // Strictly greater, so an exact tie keeps the earlier clip in track order.
    if (overlap > widest) {
      widest = overlap
      ownerId = span.id
    }
  }
  return widest > 0 ? ownerId : null
}

/** The regions `clipId` owns, used for both the clip pill badge and its menu entries. */
export function beatRepeatRegionsForClip(
  regions: readonly BeatRepeatRegion[],
  clipId: string,
  spans: readonly ClipBeatSpan[]
): BeatRepeatRegion[] {
  if (regions.length === 0 || spans.length === 0) return []
  return regions.filter((region) => beatRepeatOwnerClipId(region, spans) === clipId)
}
