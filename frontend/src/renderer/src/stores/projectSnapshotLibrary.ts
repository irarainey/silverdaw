// Library hydration for PROJECT_STATE snapshots: rebuild library rows, restore
// persisted analysis, and backfill cover art / peaks for standalone sources.

import { decodeAudioToPeaks } from '@/lib/audioDecode'
import { log } from '@/lib/log'
import { useLibraryStore } from '@/stores/libraryStore'
import type { ProjectStatePayload } from '@shared/bridge-protocol'
import type { AudioMetadata } from '@shared/types'
import { filePathToBasename } from './projectHelpers'
import type { SnapshotTarget } from './projectSnapshotTypes'

/** The folder holding a generated WAV's sibling sidecar (stem or music sample). */
function sidecarDirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '')
}

/** Strip the source file's audio geometry from inherited metadata so the
 *  generated file (stem or music sample) keeps its OWN duration/sample-rate/
 *  channel-count (decoded from its own file) while still inheriting identity
 *  tags + cover art. */
function withoutAudioGeometry(meta: AudioMetadata): AudioMetadata {
  const { durationMs: _d, sampleRate: _s, channelCount: _c, ...rest } = meta
  return rest
}

async function refreshLibraryItemMedia(
  itemId: string,
  filePath: string,
  opts?: { sidecar?: 'stem' | 'sample' }
): Promise<void> {
  const library = useLibraryStore()
  try {
    let metadata: AudioMetadata | null = null
    // A separated stem's WAV — and a saved music sample's WAV — carries no tags,
    // so prefer the sidecar copy written at creation time: it makes the inherited
    // identity (cover art + tags) survive source removal and reload. The sidecar's
    // audio geometry describes the SOURCE, so drop it and let the file's own decode
    // below supply duration/peaks.
    if (opts?.sidecar) {
      try {
        const dir = sidecarDirOf(filePath)
        const sidecar =
          opts.sidecar === 'stem'
            ? await window.silverdaw.readStemSidecar(dir)
            : await window.silverdaw.readSampleSidecar(dir)
        if (sidecar) metadata = withoutAudioGeometry(sidecar)
      } catch (err) {
        log.warn('library', `read ${opts.sidecar} sidecar failed for ${filePath}: ${String(err)}`)
      }
    }
    if (!metadata) metadata = await window.silverdaw.readAudioMetadata(filePath)
    library.setItemMetadata(itemId, metadata)
  } catch (err) {
    log.warn('library', `readAudioMetadata failed for ${filePath}: ${String(err)}`)
  }

  const item = library.getItem(itemId)
  if (!item) return
  // A saved sample (and any library audio file) is a standalone source: its peaks
  // must come from decoding its OWN file, not from a timeline clip that happens to
  // share the path. So decode whenever the item is missing its audio geometry OR
  // its peaks — otherwise a sample that was never placed on the timeline would have
  // no waveform in the library or clip editor after a project reload.
  const needsDetails = item.durationMs <= 0
  const needsPeaks = item.peaks.length === 0
  if (!needsDetails && !needsPeaks) return

  try {
    const opened = await window.silverdaw.readAudioFile(filePath)
    if (!opened) return
    const decoded = await decodeAudioToPeaks(opened.data)
    if (needsDetails) {
      library.setItemAudioDetails(itemId, decoded.durationMs, decoded.sampleRate, decoded.channelCount)
    }
    // Re-check inside the async gap: a concurrent WAVEFORM_READY route may have
    // filled the peaks while we were decoding, so don't clobber them.
    if (library.getItem(itemId)?.peaks.length === 0) {
      library.setItemPeaks(itemId, decoded.peaks, decoded.sampleRate, decoded.peaksPerSecond)
      // Populate the stereo display map from the renderer-side decode so the
      // L/R lanes are available without waiting for a backend WAVEFORM_READY.
      // Non-stereo decodes pass an empty array, which clears any prior entry.
      if (decoded.peaksPerSecond > 0) {
        library.setItemChannelPeaks(itemId, decoded.channelPeaks ?? [], decoded.peaksPerSecond)
      }
    }
  } catch (err) {
    log.warn('library', `readAudioFile/decode failed for ${filePath}: ${String(err)}`)
  }
}

/** Hydrate library rows from the snapshot and suppress echoing them back. */
export function applyProjectLibrary(_target: SnapshotTarget, snapshot: ProjectStatePayload): void {
  const library = useLibraryStore()
  // Hydrate library first and suppress echoing snapshot items back to the backend.
  if (snapshot.library) {
    for (const item of snapshot.library) {
      const already = library.byId[item.id]
      if (already) {
        // Existing items still need relinked path/unresolved fields refreshed.
        already.filePath = item.filePath
        already.fileName = item.fileName?.trim()
          ? item.fileName
          : filePathToBasename(item.filePath)
        already.playbackFilePath = item.filePath
        already.unresolved = item.unresolved === true ? true : undefined
        continue
      }
      const libId = library.addItem({
        id: item.id,
        kind: item.kind ?? 'audio-file',
        name: item.name,
        filePath: item.filePath,
        fileName: item.fileName?.trim() ? item.fileName : filePathToBasename(item.filePath),
        durationMs: Math.max(0, item.durationMs ?? 0),
        sampleRate: Math.max(0, item.sampleRate ?? 0),
        channelCount: Math.max(0, item.channelCount ?? 0),
        peaks: new Float32Array(0),
        key: item.key,
        unresolved: item.unresolved === true,
        // Keep CLIP_ADD keyed by source path; cached WAV paths are backend-internal.
        playbackFilePath: item.filePath,
        derivedFrom:
          item.kind === 'saved-clip' || item.kind === 'stem'
            ? {
                sourceItemId: item.sourceItemId,
                sourceClipId: item.sourceClipId,
                inMs: Math.max(0, item.sourceInMs ?? 0),
                durationMs: Math.max(0, item.sourceDurationMs ?? item.durationMs ?? 0)
              }
            : undefined,
        collapsed: item.collapsed === true ? true : undefined,
        warpEnabled: item.kind === 'saved-clip' && typeof item.warpEnabled === 'boolean'
          ? item.warpEnabled
          : undefined,
        warpMode: item.kind === 'saved-clip' ? item.warpMode : undefined,
        tempoRatio: item.kind === 'saved-clip' && typeof item.tempoRatio === 'number'
          ? item.tempoRatio
          : undefined,
        semitones: item.kind === 'saved-clip' && typeof item.semitones === 'number'
          ? item.semitones
          : undefined,
        cents: item.kind === 'saved-clip' && typeof item.cents === 'number'
          ? item.cents
          : undefined,
        fromSnapshot: true
      })
      // Persisted analysis hydrates immediately; new imports use LIBRARY_ITEM_ANALYSIS.
      if (typeof item.bpm === 'number' && item.bpm > 0) {
        const persistedBeats = Array.isArray(item.beats) ? item.beats : []
        const anchor =
          typeof item.beatAnchorSec === 'number'
            ? item.beatAnchorSec
            : (persistedBeats[0] ?? 0)
        library.setItemAnalysis(
          libId,
          item.bpm,
          anchor,
          persistedBeats,
          item.variableTempo === true,
          item.playbackFilePath,
          item.lowConfidence === true
        )
      }
      if (item.sampleMode === 'sample' || item.sampleMode === 'music') {
        const target = library.items.find((i) => i.id === libId)
        if (target) target.sampleMode = item.sampleMode
      }
      // Backfill metadata for older projects missing persisted duration.
      // Stems and music samples are standalone files that inherit identity
      // from a source; read their sidecar so cover art + tags survive reload.
      const reloadKind = item.kind ?? 'audio-file'
      if (reloadKind === 'audio-file') {
        void refreshLibraryItemMedia(
          libId,
          item.filePath,
          item.sampleMode === 'music' ? { sidecar: 'sample' } : undefined
        )
      } else if (reloadKind === 'stem') {
        void refreshLibraryItemMedia(libId, item.filePath, { sidecar: 'stem' })
      }
    }
    for (const item of library.items) {
      if (item.kind !== 'saved-clip' || item.bpm !== undefined) continue
      const sourceId = item.derivedFrom?.sourceItemId
      if (!sourceId) continue
      const source = library.byId[sourceId]
      if (!source || typeof source.bpm !== 'number' || source.bpm <= 0) continue
      library.setItemAnalysis(
        item.id,
        source.bpm,
        source.beatAnchorSec ?? source.beats?.[0] ?? 0,
        source.beats ?? [],
        source.variableTempo === true,
        source.decodedCacheFilePath,
        source.lowConfidence === true
      )
    }
  }
}
