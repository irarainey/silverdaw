import { decodeAudioToPeaks, detectMusicalKey } from '@/lib/audioDecode'
import { isBackendNativeAudioPath, writePlaybackWav } from '@/lib/audioPlaybackPath'
import { probeAudioFile } from '@/lib/bridgeService'

export interface GeneratedAudioGeometry {
  sampleRate: number
  durationMs: number
  channelCount: number
}

/** Playback path for an import: the source itself when the backend can read it,
 *  otherwise a cached WAV. Falls back to the source if the transcode fails, so a
 *  failed cache write still yields an importable item. */
async function resolvePlaybackPath(
  sourcePath: string,
  decoded: { sampleRate: number; channels: Float32Array[] }
): Promise<string> {
  if (isBackendNativeAudioPath(sourcePath)) return sourcePath
  return (await writePlaybackWav(sourcePath, decoded)) ?? sourcePath
}

export async function prepareAudioImport(
  opened: { filePath: string; data: ArrayBuffer },
  generatedAudio?: GeneratedAudioGeometry
): Promise<{
  decoded: Awaited<ReturnType<typeof decodeAudioToPeaks>>
  metadata: AudioMetadata | null
  detectedKey: string | undefined
  trueSampleRate: number
  playbackFilePath: string
}> {
  const [decoded, metadata] = await Promise.all([
    decodeAudioToPeaks(opened.data),
    generatedAudio
      ? Promise.resolve(null)
      : window.silverdaw.readAudioMetadata(opened.filePath).catch(() => null)
  ])
  if (generatedAudio) {
    return {
      decoded,
      metadata,
      detectedKey: undefined,
      trueSampleRate: generatedAudio.sampleRate,
      playbackFilePath: opened.filePath
    }
  }

  const probe = await probeAudioFile(opened.filePath, { timeoutMs: 5000 })
  return {
    decoded,
    metadata,
    detectedKey: detectMusicalKey(decoded.channels, decoded.sampleRate),
    trueSampleRate: probe.ok ? probe.sampleRate : decoded.sampleRate,
    playbackFilePath: await resolvePlaybackPath(opened.filePath, decoded)
  }
}
