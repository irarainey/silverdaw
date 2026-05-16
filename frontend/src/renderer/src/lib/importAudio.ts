// Shared "import an audio file into a track" flow.
//
// Bundles the three steps that always go together when bringing a file in:
//   1. Show the native open-file dialog (via the preload bridge).
//   2. Decode the file's PCM peaks in the renderer.
//   3. Mutate the project store + tell the backend so it loads the file too.
//
// Used by `TrackHeaderPanel` (per-track Import button) and any future
// "import multiple files" / drag-and-drop entry points.

import { decodeAudioToPeaks } from '@/lib/audio'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'

/**
 * File extensions the JUCE backend's `AudioFormatManager` can decode
 * natively on every supported platform. Anything outside this set is
 * round-tripped through the renderer's Web Audio decoder + a temp WAV
 * write so the backend still has a file it understands.
 *
 * Notably AAC / M4A / MP4 are NOT in this list: on Windows JUCE only
 * ships the legacy Windows Media Format SDK reader (WMA family + MP3),
 * not a Media Foundation reader, so those formats need transcoding.
 */
const BACKEND_NATIVE_EXTS: ReadonlySet<string> = new Set([
  '.wav',
  '.aif',
  '.aiff',
  '.flac',
  '.ogg',
  '.mp3',
  '.wma'
])

function fileExtensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return ''
  return filePath.slice(dot).toLowerCase()
}

/**
 * Resolve the path the JUCE backend should load for a freshly-decoded
 * file. For natively-supported formats this is just the source path.
 * Otherwise we ask main to write the decoded PCM as a temp WAV and
 * return that path. Falls back to the source path on transcode failure
 * so the user still gets a useful error from the backend.
 */
async function resolvePlaybackPath(
  sourcePath: string,
  decoded: { sampleRate: number; channels: Float32Array[] }
): Promise<string> {
  if (BACKEND_NATIVE_EXTS.has(fileExtensionOf(sourcePath))) return sourcePath
  log.info('import', `transcode start ${sourcePath}`)
  try {
    const wavPath = await window.silverdaw.writeTempWav({
      sourcePath,
      channels: decoded.channels,
      sampleRate: decoded.sampleRate
    })
    if (wavPath) {
      log.info('import', `transcode done -> ${wavPath}`)
      return wavPath
    }
    console.warn('[importAudio] transcode returned null for', sourcePath)
    log.warn('import', `transcode returned null for ${sourcePath}`)
  } catch (err) {
    console.error('[importAudio] transcode failed for', sourcePath, err)
    log.error('import', `transcode failed for ${sourcePath}: ${String(err)}`)
  }
  return sourcePath
}

/**
 * Open the audio-file dialog and add the chosen file as a clip on the given
 * track. If `startMs` is omitted the clip is placed at the current playhead
 * position. The file is also added to the project library so it can be
 * dragged onto other tracks later; if the library already contains the
 * same `filePath`, the existing decoded peaks are reused (no re-decode).
 * Returns the new clip's id, or `null` if the user cancelled / decoding
 * failed / the track is missing.
 */
export async function importAudioIntoTrack(
  trackId: string,
  startMs?: number
): Promise<string | null> {
  const project = useProjectStore()
  const transport = useTransportStore()
  const library = useLibraryStore()

  log.info('import', `importAudioIntoTrack trackId=${trackId} startMs=${startMs ?? 'playhead'}`)
  const opened = await window.silverdaw.openAudioFile().catch((err) => {
    console.error('[importAudio] dialog/read failed:', err)
    log.error('import', `dialog failed: ${String(err)}`)
    return null
  })
  if (!opened) {
    log.info('import', 'dialog cancelled')
    return null
  }

  // Default to the current playhead position so importing while the cursor
  // is parked at e.g. bar 4 drops the clip right where the user is looking.
  const resolvedStartMs = typeof startMs === 'number' ? startMs : transport.positionMs

  // Self-batch this single-file import so the status-bar progress bar
  // still shows for per-track imports (not just library batches).
  library.beginImportBatch(1)

  try {
    // Reuse the library's already-decoded data if this file is already
    // there; otherwise decode once and register the new library item.
    let audio = library.items.find((i) => i.filePath === opened.filePath) ?? null
    if (!audio) {
      // Parse peaks (slow) and tags (fast) in parallel so the card appears
      // with full info in one shot rather than text-then-pop-in-cover-art.
      const [decoded, metadata] = await Promise.all([
        decodeAudioToPeaks(opened.data),
        window.silverdaw.readAudioMetadata(opened.filePath).catch(() => null)
      ])
      // If the backend can't decode this format natively, write the
      // already-decoded PCM out as a temp WAV and point playback at that.
      const playbackFilePath = await resolvePlaybackPath(opened.filePath, decoded)
      const itemId = library.addItem({
        filePath: opened.filePath,
        fileName: opened.fileName,
        durationMs: decoded.durationMs,
        sampleRate: decoded.sampleRate,
        channelCount: decoded.channelCount,
        peaks: decoded.peaks,
        playbackFilePath
      })
      library.setItemMetadata(itemId, metadata)
      audio = library.getItem(itemId)
    }
    if (!audio) return null

    const clipId = project.addClipToTrack(
      trackId,
      {
        filePath: audio.filePath,
        fileName: libraryItemDisplayName(audio),
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks,
        // Store the backend's path on the clip so a later CLIP_ADD_FAILED
        // ack can match the optimistically-added clip and remove it.
        playbackFilePath: audio.playbackFilePath
      },
      resolvedStartMs
    )
    if (!clipId) return null

    // Tell the backend so it can load the same file for playback. Use the
    // (possibly transcoded) playback path, not the original source path.
    sendBridge('CLIP_ADD', {
      trackId,
      clipId,
      filePath: audio.playbackFilePath,
      positionMs: resolvedStartMs
    })

    return clipId
  } catch (err) {
    console.error('[importAudio] decode failed:', err)
    return null
  } finally {
    library.noteImportFinished()
  }
}

/**
 * Decode an already-opened audio file (bytes + path) and add it to the
 * project library. Items are de-duplicated by `filePath` so re-importing
 * the same file twice returns the existing item's id rather than decoding
 * again. Returns the library item's id, or `null` on decode failure.
 *
 * Always calls `library.noteImportFinished()` exactly once (success or
 * failure) so callers that called `beginImportBatch(N)` up-front see the
 * status-bar progress bar drain correctly.
 */
export async function importAudioIntoLibrary(opened: {
  filePath: string
  fileName: string
  data: ArrayBuffer
}): Promise<string | null> {
  const library = useLibraryStore()

  try {
    // Skip the decode entirely if we already have this file in the library.
    const existing = library.items.find((i) => i.filePath === opened.filePath)
    if (existing) return existing.id

    const [decoded, metadata] = await Promise.all([
      decodeAudioToPeaks(opened.data),
      window.silverdaw.readAudioMetadata(opened.filePath).catch(() => null)
    ])
    const playbackFilePath = await resolvePlaybackPath(opened.filePath, decoded)
    const itemId = library.addItem({
      filePath: opened.filePath,
      fileName: opened.fileName,
      durationMs: decoded.durationMs,
      sampleRate: decoded.sampleRate,
      channelCount: decoded.channelCount,
      peaks: decoded.peaks,
      playbackFilePath
    })
    library.setItemMetadata(itemId, metadata)
    return itemId
  } catch (err) {
    console.error('[importAudio] library decode failed:', err)
    return null
  } finally {
    library.noteImportFinished()
  }
}
