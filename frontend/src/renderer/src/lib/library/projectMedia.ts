// Project central media store — cover art + tag metadata, keyed by a per-source
// media GUID minted at first import. One entry per imported source file lives under
// <project>/metadata/<guid>.json + <project>/covers/<guid>.<ext>; every stem or
// sample derived from that source carries the SAME GUID, so they all resolve their
// identity from one shared entry (no per-item sidecars, no dependency on the origin
// library item still existing). Thin renderer wrappers over the main-process store.

import type { AudioMetadata } from '@shared/types'
import { log } from '@/lib/log'

/**
 * Persist a source's tags + cover art into the project media store under `mediaId`.
 * Main resolves the identity from the source file on disk (embedded tags for an
 * imported file, or its sidecar for a tagless stem/sample). Called once, when a
 * source is first imported; derived items reuse the GUID and never re-save.
 */
export async function saveProjectMedia(mediaId: string, sourceFilePath: string): Promise<boolean> {
  if (mediaId === '' || sourceFilePath === '') return false
  try {
    const ok = await window.silverdaw.saveProjectMedia(mediaId, sourceFilePath)
    log.info('media', `saveProjectMedia id=${mediaId} src=${sourceFilePath} ok=${ok}`)
    return ok
  } catch (err) {
    log.warn('media', `saveProjectMedia failed for ${mediaId}: ${String(err)}`)
    return false
  }
}

/** Read a source's tags + cover (cover bytes attached) back by GUID, or null when absent.
 *  The stored entry also carries the SOURCE file's audio geometry (duration / sample
 *  rate / channel count), which is meaningless for a derived stem or sample sharing the
 *  GUID — applying it would stretch a one-bar stem to the whole source. Strip it here so
 *  the media store only ever supplies identity (tags + cover); every consumer keeps its
 *  own decoded geometry. */
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
  const { durationMs: _d, sampleRate: _s, channelCount: _c, ...rest } = meta
  return rest
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
