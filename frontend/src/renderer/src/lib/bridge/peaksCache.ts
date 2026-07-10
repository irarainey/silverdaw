// Peaks-cache file decoding for the bridge.
//
// Parses the on-disk `.peaks` binary cache (written by the backend) and applies
// the decoded peaks to the relevant Pinia store. Split out of `bridgeService`
// so the binary-layout contract and its three consumers (WAVEFORM_READY,
// SAMPLE_SAVED, CLIP_EDITOR_PEAKS_READY) live in one focused module.

import { log } from '@/lib/log'
import { useLibraryStore } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useProjectStore } from '@/stores/projectStore'
import { refreshLibraryPeaksForPath } from '@/stores/projectSnapshotLibrary'
import { inheritSourceAnalysis } from '@/lib/library/inheritSourceAnalysis'
import { getProjectMedia } from '@/lib/library/projectMedia'
import { resolveLibraryItemMediaId } from '@/stores/libraryStore'
import type { SampleSavedPayload, WaveformReadyPayload } from '@shared/bridge-protocol'

/**
 * Cache-file binary layout (mirrors `backend/src/PeaksCache.cpp`):
 *
 *   bytes  0..3   u32 LE magic       — 0x53445057 ('SDPW')
 *   bytes  4..7   u32 LE version     — 2
 *   bytes  8..11  u32 LE peaksPerSec
 *   bytes 12..15  u32 LE peakCount   — (min, max) pair count PER LANE
 *   bytes 16..19  u32 LE laneCount   — 1 (summary only) or 3 (summary + L/R)
 *   bytes 20..27  f64 LE sampleRate
 *   bytes 28..    laneCount * peakCount * 2 * f32 LE peak values, laid out
 *                 channel-major: lane 0 (mono summary) in full, then lane 1
 *                 (left) and lane 2 (right) for stereo files.
 */
const PEAKS_FILE_MAGIC = 0x53445057
const PEAKS_FILE_VERSION = 2
const PEAKS_FILE_HEADER_SIZE = 28
const PEAKS_MAX_LANES = 8

export interface ParsedPeaksCache {
  /** Lane 0 — the mono summary. Existing draw/LOD code consumes this. */
  readonly summary: Float32Array
  /** Per-channel lanes for stereo (index 0 = left, 1 = right); empty for mono. */
  readonly channels: Float32Array[]
  readonly laneCount: number
}

/**
 * Parse + validate a `.peaks` cache buffer read from disk. Returns null
 * (with a warning) on any malformation so callers can simply bail. Each
 * Canonical one- and three-lane files return views into the renderer-owned IPC
 * buffer, avoiding multi-megabyte main-thread copies. Non-canonical or padded
 * files copy the used lanes so unused bytes are not retained.
 *
 * Shared by all three peaks-cache consumers (`WAVEFORM_READY`,
 * `SAMPLE_SAVED`, `CLIP_EDITOR_PEAKS_READY`) so the binary contract lives
 * in exactly one place.
 */
export function parsePeaksCacheBuffer(
  buffer: ArrayBuffer | null,
  expectedPeakCount: number,
  label: string
): ParsedPeaksCache | null {
  if (!buffer) {
    log.warn('bridge', `${label} no data`)
    return null
  }
  if (buffer.byteLength < PEAKS_FILE_HEADER_SIZE) {
    log.warn('bridge', `${label} short file bytes=${buffer.byteLength}`)
    return null
  }
  const view = new DataView(buffer)
  const magic = view.getUint32(0, /* littleEndian */ true)
  if (magic !== PEAKS_FILE_MAGIC) {
    log.warn('bridge', `${label} bad magic 0x${magic.toString(16)}`)
    return null
  }
  const version = view.getUint32(4, true)
  if (version !== PEAKS_FILE_VERSION) {
    log.warn('bridge', `${label} unsupported version=${version}`)
    return null
  }
  const headerPeakCount = view.getUint32(12, true)
  const laneCount = view.getUint32(16, true)
  if (laneCount < 1 || laneCount > PEAKS_MAX_LANES) {
    log.warn('bridge', `${label} bad laneCount=${laneCount}`)
    return null
  }
  // The header's per-lane peak count is authoritative for sizing; cross-check
  // it against the envelope so a stale/corrupt file is rejected rather than
  // mis-sliced. (Note: the header stores the integer peaks/sec request while
  // the envelope carries the fractional effective rate, so those two are
  // deliberately NOT compared.)
  if (headerPeakCount !== expectedPeakCount) {
    log.warn('bridge', `${label} peakCount mismatch header=${headerPeakCount} payload=${expectedPeakCount}`)
    return null
  }
  const floatsPerLane = headerPeakCount * 2
  const totalFloats = floatsPerLane * laneCount
  const expectedBytes = PEAKS_FILE_HEADER_SIZE + totalFloats * Float32Array.BYTES_PER_ELEMENT
  if (buffer.byteLength < expectedBytes) {
    log.warn('bridge', `${label} size mismatch got=${buffer.byteLength} expected>=${expectedBytes}`)
    return null
  }
  const all = new Float32Array(buffer, PEAKS_FILE_HEADER_SIZE, totalFloats)
  const canRetainBuffer =
    buffer.byteLength === expectedBytes && (laneCount === 1 || laneCount === 3)
  const summaryView = all.subarray(0, floatsPerLane)
  const summary = canRetainBuffer ? summaryView : new Float32Array(summaryView)
  const channels: Float32Array[] = []
  // Only 3-lane (summary + L + R) files carry separable stereo channels.
  if (laneCount === 3) {
    const left = all.subarray(floatsPerLane, floatsPerLane * 2)
    const right = all.subarray(floatsPerLane * 2, floatsPerLane * 3)
    channels.push(canRetainBuffer ? left : new Float32Array(left))
    channels.push(canRetainBuffer ? right : new Float32Array(right))
  }
  return { summary, channels, laneCount }
}

export async function loadPeaksFromCache(payload: WaveformReadyPayload): Promise<void> {
  const { clipId, cachePath, peakCount, sampleRate, peaksPerSecond } = payload
  let buffer: ArrayBuffer | null
  try {
    buffer = await window.silverdaw.readPeaksCacheFile(cachePath)
  } catch (err) {
    log.warn('bridge', `WAVEFORM_READY read failed clipId=${clipId}: ${String(err)}`)
    const clip = useProjectStore().clips[clipId]
    if (clip) refreshLibraryPeaksForPath(clip.filePath)
    return
  }
  const parsed = parsePeaksCacheBuffer(buffer, peakCount, `WAVEFORM_READY clipId=${clipId}`)
  if (!parsed) {
    const clip = useProjectStore().clips[clipId]
    if (clip) refreshLibraryPeaksForPath(clip.filePath)
    return
  }
  useProjectStore().setClipPeaks(clipId, parsed.summary, sampleRate, peaksPerSecond, parsed.channels)
  log.info(
    'bridge',
    `WAVEFORM_READY clipId=${clipId} peaks=${peakCount} lanes=${parsed.laneCount} ppS=${peaksPerSecond}`
  )
}

export async function applySampleSaved(payload: SampleSavedPayload): Promise<void> {
  const notifications = useNotificationsStore()
  if (!payload.ok) {
    notifications.pushError(`Sample export failed: ${payload.error ?? 'unknown error'}`)
    log.warn('bridge', `SAMPLE_SAVED failed source=${payload.clipId ?? payload.libraryItemId ?? '?'} error=${payload.error ?? 'unknown'}`)
    return
  }

  const buffer = await window.silverdaw.readPeaksCacheFile(payload.cachePath).catch(() => null)
  const parsed = parsePeaksCacheBuffer(buffer, payload.peakCount, `SAMPLE_SAVED itemId=${payload.itemId}`)
  const peaks = parsed?.summary ?? new Float32Array()

  const library = useLibraryStore()
  // The sample shares its source's media GUID, so its cover art + tags resolve from
  // the one project media-store entry the source already wrote at import. The source
  // may be a derived item (e.g. a library-clip region), so walk its chain to the origin.
  const mediaSource = payload.sourceItemId ? (library.byId[payload.sourceItemId] ?? null) : null
  const sampleMediaId = resolveLibraryItemMediaId(mediaSource, library.byId)
  library.addItem({
    id: payload.itemId,
    kind: 'sample',
    name: payload.name,
    filePath: payload.filePath,
    fileName: payload.fileName,
    durationMs: payload.durationMs,
    sampleRate: payload.sampleRate,
    channelCount: payload.channelCount,
    peaks,
    peaksPerSecond: payload.peaksPerSecond,
    playbackFilePath: payload.filePath,
    mediaId: sampleMediaId,
    // Record the source link as provenance so this sample reads as saved from a
    // clip (not an ordinary import) immediately — and on reload via the
    // backend-persisted sourceItemId. The backend mirrors this in the project file.
    derivedFrom: payload.sourceItemId
      ? {
          sourceItemId: payload.sourceItemId,
          inMs: payload.sourceInMs ?? 0,
          durationMs: payload.durationMs
        }
      : undefined,
    fromSnapshot: true
  })
  if (parsed && parsed.channels.length > 0) {
    library.setItemChannelPeaks(payload.itemId, parsed.channels, payload.peaksPerSecond)
  }
  // Classify the new sample. Only a MUSIC sample additionally inherits the musical grid
  // (tempo / key / beats) so it shows its grid and warps on drop — the lack of pitch +
  // BPM is the ONLY thing that distinguishes a simple sample. The backend persists the
  // same grid (and may re-broadcast it via LIBRARY_ITEM_ANALYSIS); applying it here too
  // keeps the renderer correct regardless of message ordering.
  if (payload.audioType) {
    const item = library.byId[payload.itemId]
    if (item) item.audioType = payload.audioType
    if (payload.audioType === 'music' && mediaSource) {
      inheritSourceAnalysis(library, payload.itemId, mediaSource, (payload.sourceInMs ?? 0) / 1000)
    }
    // Resolve the shared cover art + tags from the project media store by the GUID the
    // sample carries over from its source — works for both music and simple samples,
    // and regardless of whether the in-memory source still holds its own cover.
    const media = await getProjectMedia(item?.mediaId)
    if (item && media) library.setItemMetadata(payload.itemId, media)
    useProjectStore().timelineRevision++
  }
  // A batch slice-to-samples run shows ONE summary toast on the final item
  // instead of N per-sample toasts.
  if (payload.batchTotal && payload.batchTotal > 1) {
    if ((payload.batchIndex ?? 0) >= payload.batchTotal - 1) {
      notifications.pushInfo(`Saved ${payload.batchTotal} samples.`)
    }
  } else {
    notifications.pushInfo(`Saved sample "${payload.name}".`)
  }
  log.info('bridge', `SAMPLE_SAVED itemId=${payload.itemId} file=${payload.fileName}`)
}

export async function loadEditorPeaksFromCache(payload: {
  libraryItemId: string
  cachePath: string
  peakCount: number
  peaksPerSecond: number
  sampleRate: number
}): Promise<void> {
  const { libraryItemId, cachePath, peakCount, peaksPerSecond, sampleRate } = payload
  let buffer: ArrayBuffer | null
  try {
    buffer = await window.silverdaw.readPeaksCacheFile(cachePath)
  } catch (err) {
    log.warn('bridge', `CLIP_EDITOR_PEAKS_READY read failed libId=${libraryItemId}: ${String(err)}`)
    return
  }
  const parsed = parsePeaksCacheBuffer(buffer, peakCount, `CLIP_EDITOR_PEAKS_READY libId=${libraryItemId}`)
  if (!parsed) return
  useLibraryStore().setEditorHiResPeaks({
    libraryItemId,
    peaksPerSecond,
    sampleRate,
    peaks: parsed.summary,
    channels: parsed.channels
  })
  log.info(
    'bridge',
    `CLIP_EDITOR_PEAKS_READY libId=${libraryItemId} peaks=${peakCount} lanes=${parsed.laneCount} ppS=${peaksPerSecond}`
  )
}
