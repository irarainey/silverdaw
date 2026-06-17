// Best-effort deletion of a removed library item's generated project files. Gated
// behind the "clean up project files" preference (checked by the caller). The actual
// file deletion happens in the main process, which re-validates every path against the
// stems/samples write roots and the media store — so a malformed path here can never
// delete a user's original imported audio.

import { resolveLibraryItemMediaId } from '@/stores/libraryItemHelpers'
import type { LibraryItem } from '@/stores/libraryTypes'
import { log } from '@/lib/log'

export interface RemovedItemFile {
  /** Generated stem/sample WAV to delete (absolute). Undefined for items that own no
   *  deletable artifact (a plain imported source, or a saved clip). */
  wavPath?: string
  /** The item's resolved media GUID, captured BEFORE removal (while the library still
   *  holds the item and its source chain). */
  mediaId?: string
}

/**
 * Delete the generated files left behind by removed library items:
 *   - every captured stem/sample WAV, and
 *   - each media GUID no longer referenced by any remaining library item (so shared
 *     cover art / tag data is only removed once the last user is gone).
 * No-op when there is nothing to delete.
 */
export function cleanupRemovedItemFiles(
  removed: readonly RemovedItemFile[],
  remaining: readonly LibraryItem[],
  byId: Readonly<Record<string, LibraryItem>>
): void {
  const wavPaths = removed.map((r) => r.wavPath).filter((p): p is string => typeof p === 'string' && p.length > 0)
  const candidateMediaIds = new Set<string>()
  for (const r of removed) {
    if (r.mediaId) candidateMediaIds.add(r.mediaId)
  }
  const orphanMediaIds = [...candidateMediaIds].filter(
    (mediaId) => !remaining.some((item) => resolveLibraryItemMediaId(item, byId) === mediaId)
  )
  if (wavPaths.length === 0 && orphanMediaIds.length === 0) return
  log.info('library', `cleanup project files wavs=${wavPaths.length} orphanMedia=${orphanMediaIds.length}`)
  void window.silverdaw.cleanupProjectFiles({ wavPaths, mediaIds: orphanMediaIds })
}

/**
 * Capture the deletable-file info for a library item before it is removed. Only stems
 * and saved samples (audio-file items derived from a source) own a generated WAV in the
 * project folders; a plain imported source's file is the user's own and is never
 * deleted (the media GUID may still be cleaned up if it becomes orphaned).
 */
export function removedItemFileInfo(
  item: LibraryItem,
  isSampleAsset: boolean,
  mediaId: string | undefined
): RemovedItemFile {
  const ownsArtifact = item.kind === 'stem' || (item.kind === 'audio-file' && isSampleAsset)
  return {
    wavPath: ownsArtifact ? item.playbackFilePath || item.filePath : undefined,
    mediaId
  }
}
