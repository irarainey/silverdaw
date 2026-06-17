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

/** Read a source's tags + cover (cover bytes attached) back by GUID, or null when absent. */
export async function getProjectMedia(mediaId: string | undefined): Promise<AudioMetadata | null> {
  if (!mediaId) {
    log.info('media', 'getProjectMedia skipped (no mediaId on item)')
    return null
  }
  try {
    const meta = await window.silverdaw.getProjectMedia(mediaId)
    log.info('media', `getProjectMedia id=${mediaId} found=${meta != null} cover=${meta?.coverArt != null}`)
    return meta
  } catch (err) {
    log.warn('media', `getProjectMedia failed for ${mediaId}: ${String(err)}`)
    return null
  }
}
