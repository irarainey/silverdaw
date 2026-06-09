// Shared audio import flow: dialog, decode, project/library update, backend load.

import { decodeAudioToPeaks, detectMusicalKey } from '@/lib/audioDecode'
import { send as sendBridge, probeAudioFile } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import type { LibraryItem } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { promptSampleRateMismatch, type RateBucket } from '@/lib/sampleRatePrompt'

/** Backend-native formats; AAC/M4A/MP4 need renderer decode + temp WAV on Windows. */
const BACKEND_NATIVE_EXTS: ReadonlySet<string> = new Set([
  '.wav',
  '.aif',
  '.aiff',
  '.flac',
  '.mp3',
  '.wma'
])

function fileExtensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return ''
  return filePath.slice(dot).toLowerCase()
}

function withDetectedKey(metadata: AudioMetadata | null, detectedKey: string | undefined): AudioMetadata | null {
  if (!detectedKey) return metadata
  return { ...(metadata ?? {}), key: detectedKey }
}

function withRedetectedKey(metadata: AudioMetadata | null, detectedKey: string | undefined): AudioMetadata | null {
  if (metadata == null) return detectedKey ? { key: detectedKey } : metadata
  const next = { ...metadata }
  if (detectedKey) {
    next.key = detectedKey
  }
  return next
}

/** Use the source path when native; otherwise write decoded PCM to a temp WAV. */
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

/** Probe true sample rates before batched import; prompt only when buckets mismatch. */
export async function preflightSampleRates(filePaths: readonly string[]): Promise<'proceed' | 'cancel'> {
  if (filePaths.length === 0) return 'proceed'
  const project = useProjectStore()
  const ui = useUiStore()
  const effectiveProjectRate = project.targetSampleRate ?? ui.defaultProjectSampleRate
  log.info(
    'import',
    `preflightSampleRates files=${filePaths.length} effectiveProjectRate=${effectiveProjectRate}Hz (project=${project.targetSampleRate ?? 'null'} default=${ui.defaultProjectSampleRate})`
  )

  // Failed probes don't contribute to the mismatch summary.
  const probes = await Promise.all(filePaths.map((p) => probeAudioFile(p)))
  const byRate = new Map<number, number>()
  for (const p of probes) {
    if (!p.ok) continue
    if (p.sampleRate === effectiveProjectRate) continue
    byRate.set(p.sampleRate, (byRate.get(p.sampleRate) ?? 0) + 1)
  }
  if (byRate.size === 0) {
    log.info('import', 'preflightSampleRates: all probed files match project rate, no prompt')
    return 'proceed'
  }
  const summary = Array.from(byRate.entries())
    .map(([rate, count]) => `${count}@${rate}Hz`)
    .join(', ')
  log.info('import', `preflightSampleRates: mismatch buckets=${summary}, prompting`)

  const buckets: RateBucket[] = Array.from(byRate.entries()).map(
    ([sampleRate, fileCount]) => ({ sampleRate, fileCount })
  )
  try {
    const choice = await promptSampleRateMismatch(buckets, effectiveProjectRate)
    if (choice === 'cancel') return 'cancel'
    if (choice === 'switch-project') {
      // Pin to a supported project rate, capped at 48 kHz.
      const MAX_SUPPORTED = 48000
      const rates = Array.from(byRate.keys())
      let target = Math.max(...rates)
      if (target > MAX_SUPPORTED) target = MAX_SUPPORTED
      if (target === 44100 || target === 48000) {
        project.setTargetSampleRate(target)
      }
    }
    return 'proceed'
  } catch (err) {
    log.warn('import', `sample-rate prompt failed: ${String(err)}`)
    return 'proceed'
  }
}

/** Map a library item to the placement payload `addClipFromLibrary` expects, so
 *  warp, saved-clip, and tempo handling stay aligned across every caller. */
export function libraryItemToClipPlacement(audio: LibraryItem): {
  id: string
  filePath: string
  fileName: string
  durationMs: number
  sampleRate: number
  channelCount: number
  peaks: Float32Array
  peaksPerSecond?: number
  playbackFilePath?: string
  kind?: LibraryItem['kind']
  name?: string
  derivedFrom?: LibraryItem['derivedFrom']
  bpm?: number
  variableTempo?: boolean
  warpEnabled?: boolean
  warpMode?: LibraryItem['warpMode']
  tempoRatio?: number
  semitones?: number
  cents?: number
} {
  return {
    id: audio.id,
    filePath: audio.filePath,
    fileName: libraryItemDisplayName(audio),
    durationMs: audio.durationMs,
    sampleRate: audio.sampleRate,
    channelCount: audio.channelCount,
    peaks: audio.peaks,
    peaksPerSecond: audio.peaksPerSecond,
    playbackFilePath: audio.playbackFilePath,
    kind: audio.kind,
    name: audio.name,
    derivedFrom: audio.derivedFrom,
    bpm: audio.bpm,
    variableTempo: audio.variableTempo,
    warpEnabled: audio.warpEnabled,
    warpMode: audio.warpMode,
    tempoRatio: audio.tempoRatio,
    semitones: audio.semitones,
    cents: audio.cents
  }
}

/** Open one file and add it to the library, then place it on `trackId`. */
export async function importAudioIntoTrack(
  trackId: string,
  startMs?: number
): Promise<string | null> {
  const project = useProjectStore()
  const transport = useTransportStore()
  const library = useLibraryStore()

  log.info('import', `importAudioIntoTrack trackId=${trackId} startMs=${startMs ?? 'playhead'}`)
  const opened = await window.silverdaw.openAudioFile().catch((err) => {
    log.error('import', `dialog failed: ${String(err)}`)
    return null
  })
  if (!opened) {
    log.info('import', 'dialog cancelled')
    return null
  }

  // Default to the current playhead position.
  const resolvedStartMs = typeof startMs === 'number' ? startMs : transport.positionMs

  // Self-batch so per-track imports still show progress.
  library.beginImportBatch(1)

  // Reuse the library import path so decode, peaks, metadata, temp WAV, and warp stay aligned.
  const itemId = await importAudioIntoLibrary(opened)
  if (!itemId) return null
  const audio = library.getItem(itemId)
  if (!audio) return null

  // Reuse drag/drop placement so warp, collision, and saved-clip handling match.
  log.info(
    'import',
    `importAudioIntoTrack → addClipFromLibrary itemId=${audio.id} bpm=${audio.bpm ?? 'undef'} ` +
      `variableTempo=${audio.variableTempo ?? false} kind=${audio.kind ?? 'audio'}`
  )
  return project.addClipFromLibrary(trackId, libraryItemToClipPlacement(audio), resolvedStartMs)
}

/** Add an opened file to the library, de-duping by path and always draining import progress. */
export async function importAudioIntoLibrary(
  opened: {
    filePath: string
    fileName: string
    data: ArrayBuffer
  },
  options?: {
    kind?: LibraryItem['kind']
    name?: string
    derivedFrom?: LibraryItem['derivedFrom']
  }
): Promise<string | null> {
  const library = useLibraryStore()
  const importEntryId = library.beginImport(opened.fileName)

  try {
    const existing = library.items.find((i) => i.filePath === opened.filePath)
    if (existing) {
      library.finishImport(importEntryId, 'done')
      return existing.id
    }

    const [decoded, metadata] = await Promise.all([
      decodeAudioToPeaks(opened.data),
      window.silverdaw.readAudioMetadata(opened.filePath).catch(() => null)
    ])
    // Web Audio may resample; ask the backend for the file's true rate.
    const probe = await probeAudioFile(opened.filePath, { timeoutMs: 5000 })
    const trueSampleRate = probe.ok ? probe.sampleRate : decoded.sampleRate
    const detectedKey = detectMusicalKey(decoded.channels, decoded.sampleRate)
    const enrichedMetadata = withDetectedKey(metadata, detectedKey)
    const playbackFilePath = await resolvePlaybackPath(opened.filePath, decoded)
    const itemId = library.addItem({
      filePath: opened.filePath,
      fileName: opened.fileName,
      durationMs: decoded.durationMs,
      sampleRate: trueSampleRate,
      channelCount: decoded.channelCount,
      peaks: decoded.peaks,
      peaksPerSecond: decoded.peaksPerSecond,
      playbackFilePath,
      key: enrichedMetadata?.key,
      kind: options?.kind,
      name: options?.name,
      derivedFrom: options?.derivedFrom
    })
    if (decoded.channelPeaks.length > 0) {
      library.setItemChannelPeaks(itemId, decoded.channelPeaks, decoded.peaksPerSecond)
    }
    library.setItemMetadata(itemId, enrichedMetadata)
    library.markImportAnalyzing(importEntryId, itemId)
    return itemId
  } catch (err) {
    log.error('import', `library decode failed: ${String(err)}`)
    library.finishImport(importEntryId, 'failed')
    return null
  } finally {
    library.noteImportFinished()
  }
}

/** Refresh derived analysis while preserving the source file identity. */
export async function reanalyseLibraryItem(itemId: string): Promise<void> {
  const library = useLibraryStore()
  const notifications = useNotificationsStore()
  const item = library.getItem(itemId)
  if (!item) return
  const alreadyAnalysing = library.imports.some(
    (entry) =>
      entry.libraryItemId === item.id &&
      (entry.stage === 'decoding' ||
        entry.stage === 'detectingTempo' ||
        entry.stage === 'detectingBeats')
  )
  if (alreadyAnalysing) return

  library.beginImportBatch(1)
  const importEntryId = library.beginImport(item.fileName)

  try {
    const opened = await window.silverdaw.readAudioFile(item.filePath)
    if (!opened) {
      library.finishImport(importEntryId, 'failed')
      notifications.pushError(`Can't reanalyse "${item.fileName}" — source file could not be opened.`)
      return
    }

    const [decoded, metadata] = await Promise.all([
      decodeAudioToPeaks(opened.data),
      window.silverdaw.readAudioMetadata(item.filePath).catch(() => null)
    ])
    // Same true-rate probe rationale as `importAudioIntoLibrary`.
    const probe = await probeAudioFile(item.filePath, { timeoutMs: 5000 })
    const trueSampleRate = probe.ok ? probe.sampleRate : decoded.sampleRate
    const detectedKey = detectMusicalKey(decoded.channels, decoded.sampleRate)
    const enrichedMetadata = withRedetectedKey(metadata, detectedKey)
    const playbackFilePath = await resolvePlaybackPath(item.filePath, decoded)

    library.setItemAudioDetails(item.id, decoded.durationMs, trueSampleRate, decoded.channelCount)
    library.setItemPeaks(item.id, decoded.peaks, trueSampleRate, decoded.peaksPerSecond)
    library.setItemChannelPeaks(item.id, decoded.channelPeaks, decoded.peaksPerSecond)
    library.setItemKey(item.id, enrichedMetadata?.key)
    library.setItemMetadata(item.id, enrichedMetadata)
    library.clearItemAnalysis(item.id)
    library.markImportAnalyzing(importEntryId, item.id)

    sendBridge('LIBRARY_REANALYSE', {
      itemId: item.id,
      filePath: item.filePath,
      fileName: item.fileName,
      durationMs: decoded.durationMs,
      sampleRate: trueSampleRate,
      channelCount: decoded.channelCount,
      playbackFilePath,
      key: enrichedMetadata?.key ?? ''
    })
  } catch (err) {
    log.error('import', `reanalyse failed for ${item.filePath}: ${String(err)}`)
    library.finishImport(importEntryId, 'failed')
    notifications.pushError(`Reanalysis failed for "${item.fileName}".`)
  } finally {
    library.noteImportFinished()
  }
}
