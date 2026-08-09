import { decodeAudioToPeaks } from '@/lib/audioDecode'
import { log } from '@/lib/log'

/**
 * Formats the audio engine can read straight off disk.
 *
 * JUCE's basic format set covers WAV, AIFF, FLAC and MP3, and its Windows codec
 * adds the ASF family (`.wma`). Nothing in that set reads an MP4 container, so
 * an `.m4a` cannot be decoded by the backend at all — not by extension and not
 * by sniffing its contents. Anything absent from this list must therefore be
 * transcoded to a WAV in the renderer, which decodes it through Chromium, before
 * the backend is asked to play it.
 */
const BACKEND_NATIVE_EXTS: ReadonlySet<string> = new Set([
  '.wav',
  '.aif',
  '.aiff',
  '.flac',
  '.mp3',
  '.wma'
])

/** Lower-cased extension including the leading dot, or `''` when there is none. */
export function audioFileExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return ''
  return filePath.slice(dot).toLowerCase()
}

/** True when the backend can decode the file without a transcode. */
export function isBackendNativeAudioPath(filePath: string): boolean {
  return BACKEND_NATIVE_EXTS.has(audioFileExtension(filePath))
}

/**
 * Write already-decoded PCM to the shared transcode cache and return the WAV
 * path, or null when the write failed. The cache key is derived from the source
 * path and decoded geometry, so importing and auditioning the same file reuse
 * one WAV.
 */
export async function writePlaybackWav(
  sourcePath: string,
  decoded: { sampleRate: number; channels: Float32Array[] }
): Promise<string | null> {
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
  return null
}

/**
 * Resolve a path the backend can play for an arbitrary file on disk, decoding
 * and caching a WAV when the format is not natively supported. Returns null when
 * the file cannot be read or decoded, so callers can report the failure rather
 * than handing the engine a path it will reject.
 *
 * Only callers holding a raw on-disk path need this. Imported audio already
 * carries a transcoded playback path, so the library and timeline never reach
 * here.
 */
export async function ensureBackendPlayablePath(sourcePath: string): Promise<string | null> {
  if (isBackendNativeAudioPath(sourcePath)) return sourcePath

  const file = await window.silverdaw.readAudioFile(sourcePath).catch((err) => {
    log.error('import', `readAudioFile failed for ${sourcePath}: ${String(err)}`)
    return null
  })
  if (file === null) return null

  try {
    const decoded = await decodeAudioToPeaks(file.data)
    return await writePlaybackWav(sourcePath, decoded)
  } catch (err) {
    log.error('import', `decode failed for ${sourcePath}: ${String(err)}`)
    return null
  }
}
