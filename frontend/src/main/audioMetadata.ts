import type { IAudioMetadata, IPicture } from 'music-metadata'
import type { AudioMetadata } from '../shared/types'

// Avoid large cover-art blobs in renderer state.
const MAX_COVER_ART_BYTES = 2 * 1024 * 1024

function pickCoverArt(
  pictures: IPicture[] | undefined
): { data: ArrayBuffer; mimeType: string } | undefined {
  if (!pictures || pictures.length === 0) return undefined
  const front = pictures.find((p) => (p.type ?? '').toLowerCase().includes('cover')) ?? pictures[0]
  if (!front.data || front.data.length === 0 || front.data.length > MAX_COVER_ART_BYTES) {
    return undefined
  }
  // IPC should receive an owned buffer, not a parser arena view.
  const src = front.data
  const data = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer
  const mimeType = front.format || 'image/jpeg'
  return { data, mimeType }
}

export function normalizeMetadata(meta: IAudioMetadata): AudioMetadata {
  const { common, format } = meta
  const out: AudioMetadata = {}
  if (common.title) out.title = common.title
  if (common.artist) out.artist = common.artist
  if (common.albumartist) out.albumArtist = common.albumartist
  if (common.album) out.album = common.album
  if (typeof common.year === 'number') out.year = common.year
  if (common.genre && common.genre.length > 0) out.genre = common.genre
  if (common.track) {
    if (typeof common.track.no === 'number') out.trackNumber = common.track.no
    if (typeof common.track.of === 'number') out.trackTotal = common.track.of
  }
  if (common.disk) {
    if (typeof common.disk.no === 'number') out.discNumber = common.disk.no
    if (typeof common.disk.of === 'number') out.discTotal = common.disk.of
  }
  if (typeof common.bpm === 'number') out.bpm = common.bpm
  if (common.key) out.key = common.key
  if (common.composer && common.composer.length > 0) out.composer = common.composer.join(', ')
  if (common.comment && common.comment.length > 0) {
    const first = common.comment[0]
    out.comment = typeof first === 'string' ? first : (first?.text ?? undefined)
  }
  if (format.codec) out.codec = format.codec
  if (format.container) out.container = format.container
  if (typeof format.bitrate === 'number') out.bitrate = format.bitrate
  if (typeof format.duration === 'number') out.durationMs = format.duration * 1000
  if (typeof format.sampleRate === 'number') out.sampleRate = format.sampleRate
  if (typeof format.numberOfChannels === 'number') out.channelCount = format.numberOfChannels
  if (typeof format.lossless === 'boolean') out.lossless = format.lossless
  if (format.tagTypes && format.tagTypes.length > 0) out.tagTypes = [...format.tagTypes]
  const cover = pickCoverArt(common.picture)
  if (cover) out.coverArt = cover
  return out
}
