// Pure library-item helpers.
//
// Stateless functions over `LibraryItem` shapes: user-facing display name,
// source-BPM and sample/music resolution (library-clip aware), library-clip name
// building, and cover-art URL revocation. Extracted from `libraryStore` so this
// reusable logic lives apart from the Pinia store; the store imports what it
// needs and re-exports the public helpers for existing `@/stores/libraryStore`
// consumers.

import type { LibraryItem, LibraryClipSource } from './libraryTypes'

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

/** How an item's resolved tempo was arrived at. Mirrors the backend's
 *  `ProjectState::TempoReason`. */
export type TempoResolutionReason =
  /** No tempo at all — nothing to correct. */
  | 'none'
  /** A one-shot holds no tempo, inherited or otherwise (ADR 0024 rule 1). */
  | 'oneShot'
  /** Calculated from the item's own `musicalBeats` (rule 2). */
  | 'musicalLength'
  /** The item's own `bpm` property (rule 3). */
  | 'ownBpm'
  /** Owned by an ancestor the item was derived from (rule 4). */
  | 'inheritedBpm'

/** Who owns an item's tempo, how it was resolved, and what it resolves to. */
export interface TempoOwner {
  /** Undefined for `none`/`oneShot`; the item itself for `musicalLength`/`ownBpm`. */
  ownerItemId?: string
  reason: TempoResolutionReason
  /** Undefined whenever `reason` is `none` or `oneShot`. */
  bpm?: number
}

/** The minimum shape both tempo resolvers read. */
interface TempoResolvable {
  id?: string
  bpm?: number
  durationMs?: number
  musicalBeats?: number
  audioType?: 'simple' | 'music'
  derivedFrom?: LibraryClipSource
}

/**
 * Resolve an item's tempo AND who owns it, walking the `derivedFrom` chain.
 *
 * {@link libraryItemSourceBpm} answers only "what tempo?", which is all drawing and
 * warping need. Correcting a mis-detected tempo needs "whose tempo?" as well: a stem or
 * saved clip usually shows a tempo it inherits rather than owns, and writing the
 * correction onto the child would split it away from its parent while leaving every
 * sibling on the wrong number (ADR 0027). The reason matters too — a `musicalLength`
 * tempo is a measurement that a correction would discard, which the user has to be told
 * before it happens.
 *
 * Deliberately mirrors the backend's `ProjectState::resolveTempoOwner` rule for rule.
 * Unlike the single-hop lookup this replaces, the walk follows the chain to its end and
 * is cycle-safe, so an item derived from a saved clip that was itself cut from an import
 * resolves to the import.
 */
export function resolveTempoOwner(
  item: TempoResolvable | undefined | null,
  byId: Readonly<Record<string, LibraryItem>>
): TempoOwner {
  let current: TempoResolvable | undefined | null = item
  // A chain is normally one or two links (import -> saved clip -> sample), but a corrupt
  // or hand-edited project could close it into a loop, which would hang the walk.
  const visited = new Set<string>()
  let isOriginalItem = true

  while (current) {
    const currentId = current.id
    if (currentId !== undefined) {
      if (visited.has(currentId)) return { reason: 'none' }
      visited.add(currentId)
    }

    // Answer "is this a one-shot?" before resolving any tempo. A one-shot anywhere in the
    // chain ends the walk, because an ancestor with no tempo has none to pass down —
    // an explicit `audioType: 'music'` says THIS item has a pulse, it does not create one
    // in the item it was cut from (ADR 0024 rule 1).
    if (libraryItemIsSimple(current, byId)) return { reason: 'oneShot' }

    // Only the item the caller asked about may answer from its musical length: an
    // ancestor's recorded beat count describes the ancestor's file, not this one.
    if (isOriginalItem) {
      const fromLength = musicalLengthBpm(current)
      if (fromLength !== undefined) {
        return { ownerItemId: currentId, reason: 'musicalLength', bpm: fromLength }
      }
    }

    if (typeof current.bpm === 'number' && current.bpm > 0) {
      return {
        ownerItemId: currentId,
        reason: isOriginalItem ? 'ownBpm' : 'inheritedBpm',
        bpm: current.bpm
      }
    }

    const sourceId = current.derivedFrom?.sourceItemId
    // A broken link is not an error: the chain simply has no owner to reach.
    current = sourceId ? byId[sourceId] : undefined
    isOriginalItem = false
  }

  return { reason: 'none' }
}

/**
 * The single resolver for a clip or library item's ORIGINAL BPM.
 *
 * Every consumer goes through here — drawing, the beat grid, drop auto-warp, the
 * warp controls, effective duration — and it deliberately mirrors the backend's
 * `ProjectState::getLibraryItemBpm`. An item has exactly one original tempo, and
 * the two processes must never derive their own version of it: when they drifted,
 * a clip could be drawn stretched while the engine played it unwarped.
 *
 * Delegates to {@link resolveTempoOwner} so ADR 0024's rules live in exactly one
 * place; this is the hot, "what tempo?" question. The rules, in order:
 *   1. A one-shot has no tempo at all, inherited or otherwise.
 *   2. A recorded musical length wins: when the item's file is known to hold a whole
 *      number of beats, `beats * 60000 / durationMs` is a measurement of the audio
 *      rather than an opinion about it. A clip cut to a number of bars therefore
 *      stays that number of bars however its BPM is later re-detected — detection on
 *      a two-bar excerpt sees about eight beats and lands a few percent out, which is
 *      directly visible as a clip that no longer warps onto the grid. A hand-typed
 *      tempo clears the length (backend `setLibraryItemManualTempo`), so an explicit
 *      instruction still wins.
 *   3. Otherwise use the item's own BPM, falling back to the chain it was derived
 *      from — a stem or saved clip lands on its ancestor's tempo.
 */
export function libraryItemSourceBpm(
  item: TempoResolvable,
  byId: Readonly<Record<string, LibraryItem>>
): number | undefined {
  return resolveTempoOwner(item, byId).bpm
}

/**
 * Tempo implied by an item's recorded musical length, or `undefined` when it has none.
 *
 * Mirrors the backend's `ProjectState::musicalLengthBpm`. Both fields describe the file
 * on disk, so this stays correct for a sample exported with its warp baked in: the
 * export stretches the duration and leaves the beat count alone, which is exactly the
 * ratio that puts it back on the grid.
 */
export function musicalLengthBpm(item: {
  durationMs?: number
  musicalBeats?: number
}): number | undefined {
  const beats = item.musicalBeats
  const durationMs = item.durationMs
  if (typeof beats !== 'number' || !Number.isFinite(beats) || beats < 1) return undefined
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return undefined
  return (beats * 60000) / durationMs
}

/**
 * Source BPM the warp/tempo controls may offer for a library item.
 *
 * @deprecated Thin wrapper kept only as a named entry point for the warp UI; it is
 * now exactly {@link libraryItemSourceBpm}. It used to refuse inheritance for a
 * saved sample, on the reasoning that a sample is a committed standalone file — but
 * that made the warp dialog the one surface disagreeing with the timeline, the beat
 * grid and the backend, so a sample without its own baked BPM offered only a free
 * Stretch % while everything else warped it to the project tempo.
 */
export function libraryItemWarpSourceBpm(
  item: (TempoResolvable & { kind?: LibraryItem['kind'] }) | undefined,
  byId: Readonly<Record<string, LibraryItem>>
): number | undefined {
  if (!item) return undefined
  return libraryItemSourceBpm(item, byId)
}

/**
 * Effective simple-vs-music classification for a library item.
 * Resolution order (clip-aware):
 *   1. item's own `audioType` override, if set
 *   2. for saved clips, fall back to the SOURCE item's `audioType`
 *      override (so cutting a one-shot out of a musical track inherits
 *      music unless explicitly overridden on the saved clip)
 *   3. default to `false` (music)
 *
 * NOTE: low tempo-detection confidence (`lowConfidence`) does NOT make
 * an item simple. "Tempo unsure" and "non-musical" are distinct
 * concerns: a low-confidence track still shows its (rigid) beat grid and
 * stays warpable so the user can verify / correct it. Only the explicit
 * user override (`audioType === 'simple'`) classifies something as
 * simple. See `libraryItemTempoUnverified` for the unverified-grid signal.
 *
 * Used to gate beat-marker rendering, library tile BPM/key badges,
 * auto-warp on drop, and the project-BPM seed. Does NOT gate the
 * Warp / Pitch dialogs — those remain available so the user can
 * speed up / slow down / pitch shift any clip including simple ones.
 */
export function libraryItemIsSimple(
  item: { audioType?: 'simple' | 'music'; derivedFrom?: LibraryClipSource },
  byId: Readonly<Record<string, LibraryItem>>
): boolean {
  if (item.audioType === 'simple') return true
  if (item.audioType === 'music') return false
  const sourceId = item.derivedFrom?.sourceItemId
  if (sourceId) {
    const source = byId[sourceId]
    if (source) {
      if (source.audioType === 'simple') return true
      if (source.audioType === 'music') return false
    }
  }
  return false
}

/**
 * Resolve the media GUID for a (possibly derived) library item by walking its
 * `derivedFrom` chain back to the origin that actually carries one. A saved clip or
 * a sample saved from one inherits no GUID of its own, so follow the source links
 * until a `mediaId` is found. Returns undefined if none in the chain has one.
 */
export function resolveLibraryItemMediaId(
  item: { mediaId?: string; derivedFrom?: LibraryClipSource } | undefined | null,
  byId: Readonly<Record<string, LibraryItem>>
): string | undefined {
  let cur = item
  const seen = new Set<string>()
  while (cur) {
    if (cur.mediaId) return cur.mediaId
    const srcId = cur.derivedFrom?.sourceItemId
    if (!srcId || seen.has(srcId)) return undefined
    seen.add(srcId)
    cur = byId[srcId]
  }
  return undefined
}

/**
 * Whether a library item is a saved sample — a reusable WAV saved into the
 * project's `samples` folder — in either flavour:
 *   - a "music sample" (`audioType === 'music'`), which inherits the source's
 *     tempo + key so it warps and shows its grid, OR
 *   - a "simple sample" (`audioType === 'simple'`), a non-musical one-shot.
 * Both share identical provenance handling (cover art + tags); the ONLY difference
 * is that a music sample carries pitch + BPM.
 *
 * Identity comes from the explicit `sample` kind: a saved sample is the only
 * library file kind created FROM another item (its `derivedFrom.sourceItemId`
 * records that provenance for information only). `audioType` is NOT a reliable
 * tell because a plain musical import is also classified 'music'.
 *
 * Use this for the at-a-glance provenance treatment — the cover-art type badge, the
 * "Sample" type label, and tile styling. For the narrower "non-musical, hide the
 * tempo/key grid" concern use `libraryItemIsSimple` instead.
 */
export function libraryItemIsSample(
  item: { kind?: LibraryItem['kind']; derivedFrom?: LibraryClipSource; audioType?: LibraryItem['audioType'] } | undefined | null
): boolean {
  if (!item) return false
  return item.kind === 'sample'
}

/**
 * Whether a timeline clip sourced from `item` should show the "linked to
 * library" badge in its header. True for saved clips and for samples (both
 * music and simple samples) — reusable library entries a placed clip stays
 * linked to, as opposed to a plain imported source file. Mirrored by the
 * clip renderer and the rename overlay so badge width stays in sync.
 */
export function libraryItemShowsLinkBadge(
  item: { kind?: LibraryItem['kind']; derivedFrom?: LibraryClipSource; audioType?: LibraryItem['audioType'] } | undefined | null
): boolean {
  if (!item) return false
  return item.kind === 'clip' || libraryItemIsSample(item)
}

/**
 * Whether an item's detected tempo grid is unverified — i.e. tempo
 * detection returned low confidence and the user has not explicitly
 * confirmed the classification via `audioType`. Such items still show
 * their beat grid (they are not simple) but the UI may flag the grid as
 * needing review / manual correction.
 */
export function libraryItemTempoUnverified(
  item: { audioType?: 'simple' | 'music'; lowConfidence?: boolean; derivedFrom?: LibraryClipSource },
  byId: Readonly<Record<string, LibraryItem>>
): boolean {
  if (item.audioType) return false
  if (item.lowConfidence === true) return true
  const sourceId = item.derivedFrom?.sourceItemId
  if (sourceId) {
    const source = byId[sourceId]
    if (source && !source.audioType && source.lowConfidence === true) return true
  }
  return false
}

export function buildLibraryClipName(
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
