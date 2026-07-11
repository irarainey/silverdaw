import { decodeAudioToPeaks, detectMusicalKey } from '@/lib/audioDecode'
import { probeAudioFile } from '@/lib/bridgeService'
import { log } from '@/lib/log'

const BACKEND_NATIVE_EXTS: ReadonlySet<string> = new Set([
  '.wav',
  '.aif',
  '.aiff',
  '.flac',
  '.mp3',
  '.wma'
])

export interface GeneratedAudioGeometry {
  sampleRate: number
  durationMs: number
  channelCount: number
}

function fileExtensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return ''
  return filePath.slice(dot).toLowerCase()
}

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
    log.warn('import', `transcode returned null for ${sourcePath}`)
  } catch (err) {
    log.error('import', `transcode failed for ${sourcePath}: ${String(err)}`)
  }
  return sourcePath
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
