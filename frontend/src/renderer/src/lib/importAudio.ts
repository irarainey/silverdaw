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

/**
 * Open the audio-file dialog and add the chosen file as a clip on the given
 * track. If `startMs` is omitted the clip is placed at the current playhead
 * position. Returns the new clip's id, or `null` if the user cancelled /
 * decoding failed / the track is missing.
 */
export async function importAudioIntoTrack(
  trackId: string,
  startMs?: number
): Promise<string | null> {
  const project = useProjectStore()
  const transport = useTransportStore()

  const opened = await window.jackdaw.openAudioFile().catch((err) => {
    console.error('[importAudio] dialog/read failed:', err)
    return null
  })
  if (!opened) return null

  // Default to the current playhead position so importing while the cursor
  // is parked at e.g. bar 4 drops the clip right where the user is looking.
  const resolvedStartMs = typeof startMs === 'number' ? startMs : transport.positionMs

  try {
    const decoded = await decodeAudioToPeaks(opened.data)
    const clipId = project.addClipToTrack(
      trackId,
      {
        filePath: opened.filePath,
        fileName: opened.fileName,
        durationMs: decoded.durationMs,
        sampleRate: decoded.sampleRate,
        channelCount: decoded.channelCount,
        peaks: decoded.peaks
      },
      resolvedStartMs
    )
    if (!clipId) return null

    // Tell the backend so it can load the same file for playback.
    sendBridge('CLIP_ADD', {
      trackId,
      filePath: opened.filePath,
      positionMs: resolvedStartMs
    })

    return clipId
  } catch (err) {
    console.error('[importAudio] decode failed:', err)
    return null
  }
}
