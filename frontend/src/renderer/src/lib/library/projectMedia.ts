// Project central media store — cover art + tag metadata, keyed by a per-source
// media GUID minted at first import. One entry per imported source file lives under
// <project>/metadata/<guid>.json + <project>/covers/<guid>.<ext>; every stem or
// sample derived from that source carries the SAME GUID, so they all resolve their
// identity from one shared entry (no per-item sidecars, no dependency on the origin
// library item still existing). Thin renderer wrappers over the main-process store.

import type { AudioMetadata, MediaGeometryOrigin } from '@shared/types'
import type { AddLibraryItemInput } from '@/stores/libraryTypes'
import { log } from '@/lib/log'

export function itemGeometryOrigin(item?: Pick<AddLibraryItemInput, 'kind' | 'derivedFrom' | 'recordingOrigin'>): MediaGeometryOrigin {
  return !item?.recordingOrigin && (item?.derivedFrom || item?.kind === 'stem' || item?.kind === 'sample' || item?.kind === 'clip')
    ? 'output' : 'recording'
}

/**
 * Persist a source's tags + cover art into the project media store under `mediaId`.
 * Main resolves the identity from the source file on disk (embedded tags for an
 * imported file, or its sidecar for a tagless stem/sample). Called once, when a
 * source is first imported; derived items reuse the GUID and never re-save.
 */
export async function saveProjectMedia(mediaId: string, sourceFilePath: string, geometryOrigin: MediaGeometryOrigin): Promise<AudioMetadata | null> {
  if (mediaId === '' || sourceFilePath === '') return null
  try {
    const metadata = await window.silverdaw.saveProjectMedia(mediaId, sourceFilePath, geometryOrigin)
    log.info('media', `saveProjectMedia id=${mediaId} src=${sourceFilePath} ok=${metadata !== null}`)
    return metadata ? withoutAudioGeometry(metadata) : null
  } catch (err) {
    log.warn('media', `saveProjectMedia failed for ${mediaId}: ${String(err)}`)
    return null
  }
}

/** Read shared identity by GUID without applying another file's geometry to this item. */
export async function getProjectMedia(mediaId: string | undefined): Promise<AudioMetadata | null> {
  if (!mediaId) {
    log.info('media', 'getProjectMedia skipped (no mediaId on item)')
    return null
  }
  try {
    const meta = await window.silverdaw.getProjectMedia(mediaId)
    log.info('media', `getProjectMedia id=${mediaId} found=${meta != null} cover=${meta?.coverArt != null}`)
    return meta ? withoutAudioGeometry(meta) : null
  } catch (err) {
    log.warn('media', `getProjectMedia failed for ${mediaId}: ${String(err)}`)
    return null
  }
}

/** Drop the source file's audio geometry from media-store metadata so a derived item
 *  (stem or sample) keeps its OWN duration / sample-rate / channel-count while still
 *  inheriting identity tags + cover art. */
export function withoutAudioGeometry(meta: AudioMetadata): AudioMetadata {
  const { durationMs, sampleRate: _s, channelCount: _c, recordingDurationMs, ...rest } = meta
  // Legacy stores copied the parser's container verbatim. Generated audio was always WAV;
  // tags (even an embedded cover) alone do not distinguish it from the original.
  const legacyRecording = meta.geometryOrigin === undefined && typeof meta.container === 'string' &&
    /^(?:MPEG|FLAC|AIFF(?:-C)?|M4A|MP4)(?:$|\/)/i.test(meta.container)
  const duration = recordingDurationMs ?? (meta.geometryOrigin === 'recording' || legacyRecording ? durationMs : undefined)
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? { ...rest, recordingDurationMs: duration } : rest
}

/** Pick a new cover image and copy it into the covers dir as a per-item override.
 *  Returns the stored basename + bytes on success, or null when cancelled / failed. */
export async function updateItemCover(
  itemId: string,
  previousCoverFile?: string
): Promise<{ coverFile: string; data: ArrayBuffer; mimeType: string } | null> {
  try {
    const result = await window.silverdaw.updateItemCover({ itemId, previousCoverFile })
    if (result.cancelled) return null
    log.info('media', `updateItemCover id=${itemId} file=${result.coverFile}`)
    return { coverFile: result.coverFile, data: result.data, mimeType: result.mimeType }
  } catch (err) {
    log.warn('media', `updateItemCover failed for ${itemId}: ${String(err)}`)
    return null
  }
}

/** Read a per-item override cover back by its basename, or null when absent. */
export async function getItemCover(
  coverFile: string | undefined
): Promise<{ data: ArrayBuffer; mimeType: string } | null> {
  if (!coverFile) return null
  try {
    return await window.silverdaw.getItemCover(coverFile)
  } catch (err) {
    log.warn('media', `getItemCover failed for ${coverFile}: ${String(err)}`)
    return null
  }
}
