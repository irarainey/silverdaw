// Pure library-item helpers.
//
// Stateless functions over `LibraryItem` shapes: user-facing display name,
// source-BPM and sample/music resolution (saved-clip aware), saved-clip name
// building, and cover-art URL revocation. Extracted from `libraryStore` so this
// reusable logic lives apart from the Pinia store; the store imports what it
// needs and re-exports the public helpers for existing `@/stores/libraryStore`
// consumers.

import type { LibraryItem, SavedClipSource } from './libraryTypes'

/**
 * Separator between a stem's part label and its source name in the stem's
 * library/track name, e.g. "Drums — Long Train". Shared so the name is built
 * and parsed consistently.
 */
export const STEM_NAME_SEPARATOR = '—'

/**
 * Extract the part label (Vocals / Drums / …) from a stem item's name. Stem
 * names are built as "<part> {separator} <source>", so the part is everything
 * before the first separator. Falls back to the trimmed whole name (e.g. after
 * a custom rename) and finally to "Stem".
 */
export function stemPartLabel(item: { name?: string }): string {
  const name = item.name?.trim()
  if (!name) return 'Stem'
  const part = name.split(` ${STEM_NAME_SEPARATOR} `)[0]?.trim()
  return part || name
}

/**
 * Resolve a library item to the label that should be used wherever it's
 * shown to the user as a single line (clip name on the timeline, drag
 * ghost text, etc.). Prefers the tag title; falls back to the file name
 * if there's no title or the title is just whitespace.
 */
export function libraryItemDisplayName(item: {
  name?: string
  fileName: string
  metadata?: AudioMetadata | null
}): string {
  const name = item.name?.trim()
  if (name && name.length > 0) return name
  const title = item.metadata?.title?.trim()
  return title && title.length > 0 ? title : item.fileName
}

export function libraryItemSourceBpm(
  item: { bpm?: number; derivedFrom?: SavedClipSource },
  byId: Readonly<Record<string, LibraryItem>>
): number | undefined {
  if (typeof item.bpm === 'number' && item.bpm > 0) return item.bpm
  const sourceId = item.derivedFrom?.sourceItemId
  if (!sourceId) return undefined
  const source = byId[sourceId]
  return typeof source?.bpm === 'number' && source.bpm > 0 ? source.bpm : undefined
}

/**
 * Effective sample-vs-music classification for a library item.
 * Resolution order (saved-clip-aware):
 *   1. item's own `sampleMode` override, if set
 *   2. for saved clips, fall back to the SOURCE item's `sampleMode`
 *      override (so cutting a one-shot out of a musical track inherits
 *      music unless explicitly overridden on the saved clip)
 *   3. default to `false` (music)
 *
 * NOTE: low tempo-detection confidence (`lowConfidence`) does NOT make
 * an item a sample. "Tempo unsure" and "non-musical sample" are distinct
 * concerns: a low-confidence track still shows its (rigid) beat grid and
 * stays warpable so the user can verify / correct it. Only the explicit
 * user override (`sampleMode === 'sample'`) classifies something as a
 * sample. See `libraryItemTempoUnverified` for the unverified-grid signal.
 *
 * Used to gate beat-marker rendering, library tile BPM/key badges,
 * auto-warp on drop, and the project-BPM seed. Does NOT gate the
 * Warp / Pitch dialogs — those remain available so the user can
 * speed up / slow down / pitch shift any clip including samples.
 */
export function libraryItemIsSample(
  item: { sampleMode?: 'sample' | 'music'; derivedFrom?: SavedClipSource },
  byId: Readonly<Record<string, LibraryItem>>
): boolean {
  if (item.sampleMode === 'sample') return true
  if (item.sampleMode === 'music') return false
  const sourceId = item.derivedFrom?.sourceItemId
  if (sourceId) {
    const source = byId[sourceId]
    if (source) {
      if (source.sampleMode === 'sample') return true
      if (source.sampleMode === 'music') return false
    }
  }
  return false
}

/**
 * Whether an item's detected tempo grid is unverified — i.e. tempo
 * detection returned low confidence and the user has not explicitly
 * confirmed the classification via `sampleMode`. Such items still show
 * their beat grid (they are not samples) but the UI may flag the grid as
 * needing review / manual correction.
 */
export function libraryItemTempoUnverified(
  item: { sampleMode?: 'sample' | 'music'; lowConfidence?: boolean; derivedFrom?: SavedClipSource },
  byId: Readonly<Record<string, LibraryItem>>
): boolean {
  if (item.sampleMode) return false
  if (item.lowConfidence === true) return true
  const sourceId = item.derivedFrom?.sourceItemId
  if (sourceId) {
    const source = byId[sourceId]
    if (source && !source.sampleMode && source.lowConfidence === true) return true
  }
  return false
}

export function buildSavedClipName(
  source: { name?: string; fileName: string; metadata?: AudioMetadata | null },
  inMs: number,
  durationMs: number
): string {
  void durationMs
  const sourceName = libraryItemDisplayName(source).replace(/\.[^.]+$/, '')
  return `${sourceName} @ ${formatTimeForName(inMs)}`
}

function formatTimeForName(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Revoke the cover-art object URL on `item` if one has been issued.
 * Safe to call when no URL is set. Does NOT clear `item.coverArtUrl` —
 * callers either delete the item outright (no further references) or
 * overwrite the property immediately afterwards.
 */
export function revokeItemCoverArt(item: LibraryItem | undefined): void {
  if (item?.coverArtUrl) URL.revokeObjectURL(item.coverArtUrl)
}
