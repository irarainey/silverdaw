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
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useLibraryStore } from '@/stores/libraryStore'

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

  const opened = await window.jackdaw.openAudioFile().catch((err) => {
    console.error('[importAudio] dialog/read failed:', err)
    return null
  })
  if (!opened) return null

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
      const decoded = await decodeAudioToPeaks(opened.data)
      const itemId = library.addItem({
        filePath: opened.filePath,
        fileName: opened.fileName,
        durationMs: decoded.durationMs,
        sampleRate: decoded.sampleRate,
        channelCount: decoded.channelCount,
        peaks: decoded.peaks
      })
      audio = library.getItem(itemId)
    }
    if (!audio) return null

    const clipId = project.addClipToTrack(
      trackId,
      {
        filePath: audio.filePath,
        fileName: audio.fileName,
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks
      },
      resolvedStartMs
    )
    if (!clipId) return null

    // Tell the backend so it can load the same file for playback.
    sendBridge('CLIP_ADD', {
      trackId,
      filePath: audio.filePath,
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

    const decoded = await decodeAudioToPeaks(opened.data)
    return library.addItem({
      filePath: opened.filePath,
      fileName: opened.fileName,
      durationMs: decoded.durationMs,
      sampleRate: decoded.sampleRate,
      channelCount: decoded.channelCount,
      peaks: decoded.peaks
    })
  } catch (err) {
    console.error('[importAudio] library decode failed:', err)
    return null
  } finally {
    library.noteImportFinished()
  }
}
