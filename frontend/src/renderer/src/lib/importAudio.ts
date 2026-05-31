// Shared "import an audio file into a track" flow.
//
// Bundles the three steps that always go together when bringing a file in:
//   1. Show the native open-file dialog (via the preload bridge).
//   2. Decode the file's PCM peaks in the renderer.
//   3. Mutate the project store + tell the backend so it loads the file too.
//
// Used by `TrackHeaderPanel` (per-track Import button) and any future
// "import multiple files" / drag-and-drop entry points.

import { decodeAudioToPeaks, detectMusicalKey } from '@/lib/audio'
import { send as sendBridge, probeAudioFile } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { promptSampleRateMismatch, type RateBucket } from '@/lib/sampleRatePrompt'

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
    log.warn('import', `transcode returned null for ${sourcePath}`)
  } catch (err) {
    log.error('import', `transcode failed for ${sourcePath}: ${String(err)}`)
  }
  return sourcePath
}

/**
 * Pre-flight a batched import: probe every file's true sample rate
 * (via the backend's `AUDIO_FILE_PROBE` envelope), detect any that
 * differ from the project's effective target rate, and prompt the
 * user with the per-rate bucket summary. Returns `'proceed'` when the
 * user resolved the prompt (either accepted convert-on-import OR
 * switched the project to a higher rate), `'cancel'` when they
 * cancelled the batch.
 *
 * Files whose probe failed are passed through silently — the
 * downstream import path falls back to Web Audio's reported rate and
 * surfaces any decode error itself.
 *
 * Idempotent for the no-mismatch case: returns `'proceed'` without
 * touching the prompt UI when every file matches the project rate.
 */
export async function preflightSampleRates(filePaths: readonly string[]): Promise<'proceed' | 'cancel'> {
  if (filePaths.length === 0) return 'proceed'
  const project = useProjectStore()
  const ui = useUiStore()
  const effectiveProjectRate = project.targetSampleRate ?? ui.defaultProjectSampleRate
  log.info(
    'import',
    `preflightSampleRates files=${filePaths.length} effectiveProjectRate=${effectiveProjectRate}Hz (project=${project.targetSampleRate ?? 'null'} default=${ui.defaultProjectSampleRate})`
  )

  // Parallel probe; failures fall back to "rate unknown" and don't
  // contribute to the mismatch summary.
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
      // Pick the highest rate the user has files at, capped at 48 kHz
      // (the project's hard cap). When the source rates are all below
      // the cap and one of them matches a supported project rate
      // (44 100 / 48 000), pin to that rate; otherwise pin to 48 000
      // and the convert step in the import flow will handle the cap.
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

  // Delegate library registration to the exact same helper the
  // library-panel Import button uses, so the two entry points share
  // their decode + peaks + metadata + temp-WAV pipeline. Without
  // this, a bug fix in one path would silently miss the other (and
  // historically the per-track path forgot to call
  // `applyDropTimeWarp` — see the auto-warp-on-import bug).
  const itemId = await importAudioIntoLibrary(opened)
  if (!itemId) return null
  const audio = library.getItem(itemId)
  if (!audio) return null

  // Place the new library item on the requested track. Reuses the
  // drag-and-drop entry point so the warp / collision / saved-clip
  // logic is identical. `addClipFromLibrary` already sends `CLIP_ADD`
  // and runs `applyDropTimeWarp` for us.
  log.info(
    'import',
    `importAudioIntoTrack → addClipFromLibrary itemId=${audio.id} bpm=${audio.bpm ?? 'undef'} ` +
      `variableTempo=${audio.variableTempo ?? false} kind=${audio.kind ?? 'audio'}`
  )
  return project.addClipFromLibrary(
    trackId,
    {
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
    },
    resolvedStartMs
  )
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
  const importEntryId = library.beginImport(opened.fileName)

  try {
    // Skip the decode entirely if we already have this file in the library.
    const existing = library.items.find((i) => i.filePath === opened.filePath)
    if (existing) {
      library.finishImport(importEntryId, 'done')
      return existing.id
    }

    const [decoded, metadata] = await Promise.all([
      decodeAudioToPeaks(opened.data),
      window.silverdaw.readAudioMetadata(opened.filePath).catch(() => null)
    ])
    // Web Audio's `decodeAudioData` silently resamples to the
    // AudioContext rate (typically 48 kHz on Windows), so the rate on
    // `decoded` may not match the source file. Ask the backend for
    // the file's true rate via the format-header probe; fall back to
    // the Web-Audio-reported rate if the probe fails.
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
      key: enrichedMetadata?.key
    })
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

/**
 * Force-refresh all derived analysis for an existing library item:
 * renderer-side decode/peaks/key metadata plus backend decoded-WAV cache
 * and BPM/beat detection. The source file stays the stable identity of the
 * library item; only derived fields are replaced.
 */
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
    // Same true-rate probe rationale as `importAudioIntoLibrary`: Web
    // Audio's `decodeAudioData` resamples to the AudioContext rate
    // and lies about the source rate on Windows.
    const probe = await probeAudioFile(item.filePath, { timeoutMs: 5000 })
    const trueSampleRate = probe.ok ? probe.sampleRate : decoded.sampleRate
    const detectedKey = detectMusicalKey(decoded.channels, decoded.sampleRate)
    const enrichedMetadata = withRedetectedKey(metadata, detectedKey)
    const playbackFilePath = await resolvePlaybackPath(item.filePath, decoded)

    library.setItemAudioDetails(item.id, decoded.durationMs, trueSampleRate, decoded.channelCount)
    library.setItemPeaks(item.id, decoded.peaks, trueSampleRate, decoded.peaksPerSecond)
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
