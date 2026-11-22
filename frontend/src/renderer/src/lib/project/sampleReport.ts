import { effectiveClipDurationMs } from '@/lib/clip/clipTiming'
import { basename, reportFilePath } from './projectPath'
import { recordingUsage } from './recordingUsage'
import { libraryItemDisplayName } from '@/stores/libraryItemHelpers'
import type { LibraryItem } from '@/stores/libraryTypes'
import { filePathKey as pathKey } from '@/stores/projectHelpers'
import { isTrackSilenced, type Clip, type Track } from '@/stores/projectTypes'

interface Placement {
  id: string
  name: string
  fileType: string
  stemRole?: string
  track: string
  startMs: number
  endMs: number
  durationMs: number
  sourceStartMs: number
  sourceEndMs: number
  originalRange?: { startMs: number; endMs: number }
  originalWindow?: { startMs: number; endMs: number }
  excluded?: string
}

interface ReportSource {
  key: string
  path: string
  pathMatch?: 'project folder' | 'recording metadata'
  title: string
  artist: string
  album: string
  hasSeparatedStems: boolean
  files: { path: string; placements: Placement[] }[]
}

interface Provenance {
  original?: LibraryItem
  offsetMs?: number
  sharedKey?: string
  attribution?: LibraryItem['attribution']
  hasStem: boolean
  pathMatch?: ReportSource['pathMatch']
}

const compareText = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare
const fileTypes: Record<LibraryItem['kind'], string> = {
  source: 'Source',
  stem: 'Stem',
  sample: 'Sample',
  clip: 'Saved clip'
}

function artifactSourceName(path: string, projectRoot: string): string | undefined {
  if (!projectRoot) return undefined
  const relative = reportFilePath(path, projectRoot)
  if (relative === path) return undefined
  const parts = /^\\(stems|channels|samples)\\([^\\]+)\\[^\\]+$/i.exec(relative)
  if (!parts) return undefined
  return parts[1]?.toLowerCase() === 'stems'
    ? /^(.+)-stems(?:-\d+)?$/i.exec(parts[2] ?? '')?.[1]?.toLowerCase()
    : parts[2]?.toLowerCase()
}

function recordingKey(item: LibraryItem): string | undefined {
  const fields = (['title', 'artist', 'album'] as const).map(field =>
    (item.attribution?.[field]?.trim() || item.metadata?.[field]?.trim())?.toLowerCase())
  return fields.every(Boolean) ? JSON.stringify(fields) : undefined
}

/** Imported stems retain the original media-store tags, not its local library ID. */
function matchRecording(item: LibraryItem, candidates: ReadonlyMap<string, LibraryItem[]>): LibraryItem | undefined {
  const key = recordingKey(item)
  const duration = item.metadata?.recordingDurationMs ?? (!item.attribution ? item.metadata?.durationMs : undefined)
  if (!key || !duration) return undefined
  let match: LibraryItem | undefined
  for (const candidate of candidates.get(key) ?? []) {
    if (candidate.unresolved) continue
    const originalDuration = candidate.metadata?.recordingDurationMs ?? candidate.metadata?.durationMs ?? candidate.durationMs
    if (!originalDuration || Math.abs(originalDuration - duration) > 1) continue
    if (match && pathKey(match.filePath) !== pathKey(candidate.filePath)) return undefined
    match = candidate
  }
  const name = item.attribution && basename(item.attribution.fileName).toLowerCase()
  if (name && match && ![match.filePath, match.attribution?.fileName].some(file =>
    file && basename(file).toLowerCase() === name)) return undefined
  return match
}

function indexUniquePath(index: Map<string, LibraryItem | null>, key: string, entry: LibraryItem): void {
  const previous = index.get(key)
  if (previous === undefined) index.set(key, entry)
  else if (previous && pathKey(previous.filePath) !== pathKey(entry.filePath)) index.set(key, null)
}

function portableKey(snapshot: NonNullable<LibraryItem['attribution']>): string {
  // l1, l2, … were minted per project, not per recording.
  return /^l\d+$/.test(snapshot.recordingId)
    ? JSON.stringify([snapshot.recordingId, basename(snapshot.fileName).toLowerCase()])
    : snapshot.recordingId
}

function hasLocalParent(item: LibraryItem, root: LibraryItem, byId: Readonly<Record<string, LibraryItem>>): boolean {
  let cursor: LibraryItem | undefined = item
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor.id)) {
    if (cursor.id === root.id) return true
    seen.add(cursor.id)
    cursor = cursor.derivedFrom?.sourceItemId ? byId[cursor.derivedFrom.sourceItemId] : undefined
  }
  return false
}

function recordingResolver(
  clips: Readonly<Record<string, Clip>>,
  byId: Readonly<Record<string, LibraryItem>>,
  projectRoot: string
) {
  const origins = new Map<string, Provenance>()
  const originals = new Map<string, LibraryItem | null>()
  const byRecording = new Map<string, LibraryItem[]>()
  const byFilename = new Map<string, LibraryItem | null>()
  for (const entry of Object.values(byId)) {
    if (entry.kind !== 'source' && !entry.recordingOrigin) continue
    for (const id of [entry.id, entry.mediaId, entry.attribution?.recordingId]) {
      if (!id) continue
      indexUniquePath(originals, id, entry)
    }
    const tags = recordingKey(entry)
    if (tags) {
      const candidates = byRecording.get(tags)
      if (candidates) candidates.push(entry)
      else byRecording.set(tags, [entry])
    }
    const name = basename(entry.filePath).replace(/\.[^.]+$/, '').toLowerCase()
    indexUniquePath(byFilename, name, entry)
  }
  // One sibling's hydrated recording duration can identify the group even if
  // another sibling has no media-store metadata of its own.
  const metadataMatches = new Map<string, LibraryItem | null>()
  for (const item of Object.values(byId)) {
    const capsule = item.attribution
    if (!capsule || item.kind === 'source' || item.recordingOrigin) continue
    const match = matchRecording(item, byRecording)
    if (match) indexUniquePath(metadataMatches, portableKey(capsule), match)
  }
  return (item: LibraryItem): Provenance => {
    const cached = origins.get(item.id)
    if (cached) return cached
    let ancestor = item
    let offsetMs: number | undefined = 0
    let hasStem = ancestor.kind === 'stem'
    const seen = new Set<string>()
    while (!ancestor.attribution && ancestor.derivedFrom && !seen.has(ancestor.id)) {
      seen.add(ancestor.id)
      const { sourceItemId, sourceClipId } = ancestor.derivedFrom
      const linkedClip = sourceClipId ? clips[sourceClipId] : undefined
      const parent: LibraryItem | undefined = (sourceItemId ? byId[sourceItemId] : undefined)
        ?? (linkedClip ? byId[linkedClip.libraryItemId] : undefined)
      if (!parent) break
      // Saved clips share the parent file: clip.inMs already includes their trim.
      if (ancestor.kind !== 'clip' || pathKey(ancestor.filePath) !== pathKey(parent.filePath)) {
        const aligned = (ancestor.kind === 'stem' || ancestor.kind === 'sample') &&
          !ancestor.scratchOrigin && !ancestor.derivedFrom.unmapped
        offsetMs = aligned && offsetMs !== undefined ? offsetMs + ancestor.derivedFrom.inMs : undefined
      }
      ancestor = parent
      hasStem ||= parent.kind === 'stem'
    }
    const capsule = ancestor.attribution
    let provenance: Provenance
    if (capsule) {
      const idMatch = originals.get(capsule.recordingId)
      const key = portableKey(capsule)
      const trusted = idMatch && (!/^l\d+$/.test(capsule.recordingId) || hasLocalParent(ancestor, idMatch, byId))
      const matched = !trusted && idMatch !== null ? metadataMatches.get(key) : undefined
      const local = trusted ? idMatch : matched
      provenance = {
        original: local && !local.unresolved ? local : undefined,
        attribution: capsule, offsetMs, hasStem: hasStem || Boolean(capsule.stemRole),
        pathMatch: matched ? 'recording metadata' : undefined,
        sharedKey: local && !local.unresolved ? undefined : `recording:${key}`
      }
    } else {
      const mediaId = ancestor.mediaId ?? item.mediaId
      const missingParent = ancestor.derivedFrom?.sourceItemId
      const linked = ancestor.kind === 'source' ? ancestor : mediaId ? originals.get(mediaId) : undefined
      const inferredName = !linked && !ancestor.recordingOrigin && artifactSourceName(ancestor.filePath, projectRoot)
      const inferred = inferredName ? byFilename.get(inferredName) : undefined
      const matched = !linked && !inferred && !ancestor.recordingOrigin
        ? matchRecording(ancestor, byRecording) : undefined
      const original = linked ?? inferred ?? matched
      const sharedKey = !original && !ancestor.recordingOrigin && (missingParent || ancestor.kind === 'stem' || mediaId)
        ? `recording:${mediaId ?? missingParent ?? ancestor.id}` : undefined
      provenance = {
        original: original ?? (sharedKey ? undefined : ancestor), sharedKey, hasStem,
        offsetMs: !ancestor.derivedFrom && (ancestor.kind === 'source' || ancestor.recordingOrigin) && (!original || ancestor === original)
          ? offsetMs : undefined,
        pathMatch: inferred ? 'project folder' : matched ? 'recording metadata' : undefined
      }
    }
    origins.set(item.id, provenance)
    return provenance
  }
}

function originalPassage(provenance: Provenance | undefined, clip: Clip): Pick<Placement, 'originalRange' | 'originalWindow'> {
  const capsule = provenance?.attribution
  const offset = provenance?.offsetMs
  if (offset !== undefined && (!capsule || (capsule.ratio !== undefined && capsule.startMs !== undefined))) {
    const ratio = capsule?.ratio ?? 1
    const startMs = (capsule?.startMs ?? 0) + (offset + clip.inMs) * ratio
    const endMs = Math.min(capsule?.endMs ?? Infinity, startMs + clip.durationMs * ratio)
    return endMs > startMs ? { originalRange: { startMs, endMs } } : {}
  }
  if (capsule?.startMs !== undefined && capsule.endMs !== undefined && capsule.endMs > capsule.startMs) {
    return { originalWindow: { startMs: capsule.startMs, endMs: capsule.endMs } }
  }
  return {}
}

export function buildSampleReport(
  tracks: readonly Track[],
  clips: Readonly<Record<string, Clip>>,
  byId: Readonly<Record<string, LibraryItem>>,
  projectRoot = ''
) {
  const sources = new Map<string, ReportSource>()
  const anySoloed = tracks.some(track => track.soloed)
  const resolve = recordingResolver(clips, byId, projectRoot)
  for (const [index, track] of tracks.entries()) {
    const placed = track.clipIds.map(id => clips[id])
      .filter(clip => clip !== undefined)
      .sort((a, b) => a.startMs - b.startMs)
    for (const clip of placed) {
      const item = byId[clip.libraryItemId]
      const path = item?.filePath || clip.filePath
      const provenance = item && resolve(item)
      const origin = provenance?.original
      const capsule = provenance?.attribution
      const snapshotName = capsule && basename(capsule.fileName)
      const sourcePath = capsule ? origin?.filePath || snapshotName || ''
        : provenance?.sharedKey ? '' : origin?.filePath || path
      const key = provenance?.sharedKey ?? (pathKey(sourcePath) || clip.libraryItemId)
      const tag = (field: 'title' | 'artist' | 'album') =>
        capsule?.[field]?.trim() || origin?.metadata?.[field]?.trim() || item?.metadata?.[field]?.trim()
      let source = sources.get(key)
      if (!source) {
        source = {
          key,
          path: sourcePath,
          pathMatch: provenance?.pathMatch,
          title: tag('title') || snapshotName || (provenance?.sharedKey ? 'Unidentified recording' : origin?.fileName || item?.fileName || clip.fileName),
          artist: tag('artist') || 'Cannot be determined',
          album: tag('album') || 'Cannot be determined',
          files: [],
          hasSeparatedStems: false
        }
        sources.set(key, source)
      } else {
        // A later sibling may retain tags missing from the first stem.
        if (!source.path && sourcePath) source.path = sourcePath
        if (source.title === 'Unidentified recording' || source.title === snapshotName || source.title === origin?.fileName) {
          source.title = tag('title') || source.title
        }
        if (source.artist === 'Cannot be determined') source.artist = tag('artist') || source.artist
        if (source.album === 'Cannot be determined') source.album = tag('album') || source.album
      }
      const durationMs = effectiveClipDurationMs(clip)
      let file = source.files.find(file => pathKey(file.path) === pathKey(path))
      if (!file) {
        file = { path, placements: [] }
        source.files.push(file)
      }
      if (provenance?.hasStem) source.hasSeparatedStems = true
      if (provenance?.pathMatch) source.pathMatch = provenance.pathMatch
      file.placements.push({
        id: clip.id,
        name: clip.name || (item ? libraryItemDisplayName(item) : clip.fileName),
        fileType: item ? fileTypes[item.kind] : 'Cannot be determined',
        stemRole: capsule?.stemRole,
        track: `${index + 1}. ${track.name}`,
        excluded: isTrackSilenced(track, anySoloed) ? track.muted ? 'Muted' : 'Excluded by solo' : undefined,
        ...originalPassage(provenance, clip),
        startMs: clip.startMs,
        endMs: clip.startMs + durationMs,
        durationMs,
        sourceStartMs: clip.inMs,
        sourceEndMs: clip.inMs + clip.durationMs
      })
    }
  }
  for (const source of sources.values()) source.files.sort((a, b) => compareText(a.path, b.path))
  return [...sources.values()].sort((a, b) => compareText(a.title, b.title) || compareText(a.path, b.path))
    .map(source => ({ ...source, usage: recordingUsage(source.files) }))
}
