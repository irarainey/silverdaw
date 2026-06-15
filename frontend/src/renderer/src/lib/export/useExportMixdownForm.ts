// Transactional form model for the Export Mixdown dialog.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { beginMixdown } from '@/lib/mixdownState'
import { formatTime, parseTime, msPerSubBeat, DEFAULT_SUBS_PER_BEAT, DEFAULT_BEATS_PER_BAR } from '@/lib/musicTime'
import { effectiveClipDurationMs } from '@/stores/projectStore'
import { log } from '@/lib/log'

export type ExportFormat = 'wav' | 'mp3' | 'flac' | 'aiff'

/** Loudness mode: no-op, analyze-only, fixed normalization preset, or custom target. */
export type LoudnessPreset =
  | 'off'
  | 'streaming-14'
  | 'apple-16'
  | 'broadcast-23'
  | 'analyze'
  | 'custom'

const EXPORT_SETTINGS_VERSION = 1 as const

interface PersistedExportSettings {
  version: typeof EXPORT_SETTINGS_VERSION
  outputPath: string
  format: ExportFormat
  sampleRate: 44100 | 48000
  bitDepth: 16 | 24 | 32
  dither: boolean
  tailSecondsText: string
  bitrate: 128 | 192 | 320
  loudnessPreset: LoudnessPreset
  customTargetText: string
  customCeilingText: string
  lengthMode: 'trim-to-last-clip' | 'fixed-duration'
  durationText: string
  title: string
  artist: string
  album: string
  year: string
  genre: string
  comment: string
}

export interface ExportMixdownFormDeps {
  requestClose: () => void
}

export interface ExportMixdownForm {
  draftOutputPath: Ref<string>
  draftFormat: Ref<ExportFormat>
  draftSampleRate: Ref<44100 | 48000>
  draftBitDepth: Ref<16 | 24 | 32>
  draftDither: Ref<boolean>
  draftTailSecondsText: Ref<string>
  draftBitrate: Ref<128 | 192 | 320>
  draftLoudnessPreset: Ref<LoudnessPreset>
  draftCustomTargetText: Ref<string>
  draftCustomCeilingText: Ref<string>
  draftLengthMode: Ref<'trim-to-last-clip' | 'fixed-duration'>
  draftDurationText: Ref<string>
  draftMixdownStartBar: Ref<number>
  mixdownStartMs: ComputedRef<number>
  draftTitle: Ref<string>
  draftArtist: Ref<string>
  draftAlbum: Ref<string>
  draftYear: Ref<string>
  draftGenre: Ref<string>
  draftComment: Ref<string>
  submitting: Ref<boolean>
  loudnessAvailable: ComputedRef<boolean>
  customLoudnessActive: ComputedRef<boolean>
  customTargetValid: ComputedRef<boolean>
  customCeilingValid: ComputedRef<boolean>
  loudnessValid: ComputedRef<boolean>
  availableBitDepths: ComputedRef<readonly (16 | 24 | 32)[]>
  ditherApplies: ComputedRef<boolean>
  tailValid: ComputedRef<boolean>
  effectiveProjectRate: ComputedRef<44100 | 48000>
  lastClipEndMs: ComputedRef<number>
  duration: ComputedRef<number>
  durationValid: ComputedRef<boolean>
  pathValid: ComputedRef<boolean>
  formIsValid: ComputedRef<boolean>
  expectedFileExtension: ComputedRef<ExportFormat>
  reseedOnOpen: () => Promise<void>
  onBrowseClick: () => Promise<void>
  onSave: () => void
}

export function useExportMixdownForm(deps: ExportMixdownFormDeps): ExportMixdownForm {
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const notifications = useNotificationsStore()

  // ── Draft fields ───────────────────────────────────────────────────────
  const draftOutputPath = ref('')
  const draftFormat = ref<ExportFormat>('wav')
  const draftSampleRate = ref<44100 | 48000>(44100)
  const draftBitDepth = ref<16 | 24 | 32>(16)
  const draftDither = ref<boolean>(true)
  /** Tail as editable text; blank means no tail. */
  const draftTailSecondsText = ref('0')
  const draftBitrate = ref<128 | 192 | 320>(192)
  // ── Loudness / normalization ───────────────────────────────────────────
  const draftLoudnessPreset = ref<LoudnessPreset>('off')
  const draftCustomTargetText = ref('-14')
  const draftCustomCeilingText = ref('-1')
  /** Loudness modes require a standard sample rate. */
  const loudnessAvailable = computed<boolean>(
    () => draftSampleRate.value === 44100 || draftSampleRate.value === 48000
  )
  const customLoudnessActive = computed<boolean>(() => draftLoudnessPreset.value === 'custom')
  const customTargetLufs = computed<number>(() => Number(draftCustomTargetText.value.trim()))
  const customCeilingDbtp = computed<number>(() => Number(draftCustomCeilingText.value.trim()))
  const customTargetValid = computed<boolean>(() => {
    const n = customTargetLufs.value
    return Number.isFinite(n) && n >= -30 && n <= -6
  })
  const customCeilingValid = computed<boolean>(() => {
    const n = customCeilingDbtp.value
    return Number.isFinite(n) && n >= -9 && n <= 0
  })
  const loudnessValid = computed<boolean>(() => {
    if (!customLoudnessActive.value) return true
    return customTargetValid.value && customCeilingValid.value
  })
  /** Map preset to the optional MIXDOWN_START loudness block. */
  function buildLoudnessPayload():
    | {
        mode: 'off' | 'analyze' | 'normalize'
        targetLufs?: number
        ceilingDbtp?: number
      }
    | undefined {
    switch (draftLoudnessPreset.value) {
      case 'off':
        return undefined
      case 'analyze':
        return { mode: 'analyze' }
      case 'streaming-14':
        return { mode: 'normalize', targetLufs: -14, ceilingDbtp: -1 }
      case 'apple-16':
        return { mode: 'normalize', targetLufs: -16, ceilingDbtp: -1 }
      case 'broadcast-23':
        return { mode: 'normalize', targetLufs: -23, ceilingDbtp: -2 }
      case 'custom':
        return {
          mode: 'normalize',
          targetLufs: customTargetLufs.value,
          ceilingDbtp: customCeilingDbtp.value
        }
    }
  }
  const draftLengthMode = ref<'trim-to-last-clip' | 'fixed-duration'>('fixed-duration')
  const draftDurationText = ref('')
  // Displayed bar marker the mixdown begins from; converted to a project-time offset below.
  const draftMixdownStartBar = ref(0)
  const draftTitle = ref('')
  const draftArtist = ref('')
  const draftAlbum = ref('')
  const draftYear = ref('')
  const draftGenre = ref('')
  const draftComment = ref('')

  const submitting = ref(false)

  // ── Derived ────────────────────────────────────────────────────────────

  /** Bit-depth choices valid for the selected format. */
  const availableBitDepths = computed<readonly (16 | 24 | 32)[]>(() => {
    if (draftFormat.value === 'flac') return [16, 24] as const
    if (draftFormat.value === 'aiff') return [16, 24] as const
    if (draftFormat.value === 'wav') return [16, 24, 32] as const
    return [] as const
  })

  /** TPDF dither only meaningfully affects 16-bit integer outputs. */
  const ditherApplies = computed<boolean>(
    () => draftFormat.value !== 'mp3' && draftBitDepth.value === 16
  )

  const tailSeconds = computed<number>(() => {
    const raw = draftTailSecondsText.value.trim()
    if (raw.length === 0) return 0
    const n = Number(raw)
    if (!Number.isFinite(n)) return NaN
    return n
  })

  const tailValid = computed<boolean>(() => {
    const t = tailSeconds.value
    return Number.isFinite(t) && t >= 0 && t <= 60
  })

  /** Project sample rate with user default fallback. */
  const effectiveProjectRate = computed<44100 | 48000>(() => {
    const projectRate = project.targetSampleRate
    if (projectRate === 44100 || projectRate === 48000) return projectRate
    const fallback = ui.defaultProjectSampleRate
    return fallback === 48000 ? 48000 : 44100
  })

  /** Latest clip end in timeline ms, accounting for warp. */
  const lastClipEndMs = computed<number>(() => {
    let maxEnd = 0
    for (const clipId in project.clips) {
      const clip = project.clips[clipId]
      if (!clip) continue
      const effective = effectiveClipDurationMs(clip)
      maxEnd = Math.max(maxEnd, clip.startMs + effective)
    }
    return maxEnd
  })

  const duration = computed<number>(() => {
    if (draftLengthMode.value === 'trim-to-last-clip') return lastClipEndMs.value
    const parsed = parseTime(draftDurationText.value)
    return parsed ?? 0
  })

  const durationValid = computed<boolean>(() => {
    if (draftLengthMode.value === 'trim-to-last-clip') return lastClipEndMs.value > 0
    return duration.value > 0
  })

  // Convert the displayed start bar to a project-time offset. The ruler labels internal bar
  // index i as `i + 1 + barCounterStart`, so the inverse gives the internal index to skip to.
  const mixdownStartMs = computed<number>(() => {
    const msPerBar =
      msPerSubBeat(transport.bpm) * DEFAULT_SUBS_PER_BEAT * DEFAULT_BEATS_PER_BAR
    const internalBarIndex = Math.max(
      0,
      Math.round(draftMixdownStartBar.value) - 1 - project.barCounterStart
    )
    return internalBarIndex * msPerBar
  })

  const pathValid = computed<boolean>(
    () => typeof draftOutputPath.value === 'string' && draftOutputPath.value.trim().length > 0
  )

  const formIsValid = computed<boolean>(
    () =>
      pathValid.value &&
      durationValid.value &&
      tailValid.value &&
      loudnessValid.value &&
      !submitting.value
  )

  const expectedFileExtension = computed<ExportFormat>(() =>
    draftFormat.value === 'mp3'
      ? 'mp3'
      : draftFormat.value === 'flac'
        ? 'flac'
        : draftFormat.value === 'aiff'
          ? 'aiff'
          : 'wav'
  )

  // ── Persisted export settings (project level) ─────────────────────────
  // Whitelist the project JSON blob so malformed or newer settings cannot break the dialog.
  // Parse failure leaves the backend blob untouched for future versions.
  function applyPersistedExportSettings(blob: string | null): boolean {
    if (!blob) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(blob)
    } catch {
      log.warn('mixdown', 'exportSettingsJson parse failed; using defaults')
      return false
    }
    if (typeof parsed !== 'object' || parsed === null) return false
    const obj = parsed as Record<string, unknown>
    if (obj.version !== EXPORT_SETTINGS_VERSION) return false

    const validFormats: ExportFormat[] = ['wav', 'mp3', 'flac', 'aiff']
    if (typeof obj.format === 'string' && (validFormats as string[]).includes(obj.format)) {
      draftFormat.value = obj.format as ExportFormat
    }
    if (obj.sampleRate === 44100 || obj.sampleRate === 48000) {
      draftSampleRate.value = obj.sampleRate
    }
    if (obj.bitDepth === 16 || obj.bitDepth === 24 || obj.bitDepth === 32) {
      draftBitDepth.value = obj.bitDepth
    }
    if (typeof obj.dither === 'boolean') draftDither.value = obj.dither
    if (typeof obj.tailSecondsText === 'string') draftTailSecondsText.value = obj.tailSecondsText
    if (obj.bitrate === 128 || obj.bitrate === 192 || obj.bitrate === 320) {
      draftBitrate.value = obj.bitrate
    }
    const validPresets: LoudnessPreset[] = [
      'off',
      'streaming-14',
      'apple-16',
      'broadcast-23',
      'analyze',
      'custom'
    ]
    if (
      typeof obj.loudnessPreset === 'string' &&
      (validPresets as string[]).includes(obj.loudnessPreset)
    ) {
      draftLoudnessPreset.value = obj.loudnessPreset as LoudnessPreset
    }
    if (typeof obj.customTargetText === 'string') draftCustomTargetText.value = obj.customTargetText
    if (typeof obj.customCeilingText === 'string')
      draftCustomCeilingText.value = obj.customCeilingText
    if (obj.lengthMode === 'trim-to-last-clip' || obj.lengthMode === 'fixed-duration') {
      draftLengthMode.value = obj.lengthMode
    }
    if (typeof obj.durationText === 'string') draftDurationText.value = obj.durationText
    if (typeof obj.title === 'string') draftTitle.value = obj.title
    if (typeof obj.artist === 'string') draftArtist.value = obj.artist
    if (typeof obj.album === 'string') draftAlbum.value = obj.album
    if (typeof obj.year === 'string') draftYear.value = obj.year
    if (typeof obj.genre === 'string') draftGenre.value = obj.genre
    if (typeof obj.comment === 'string') draftComment.value = obj.comment
    if (typeof obj.outputPath === 'string' && obj.outputPath.length > 0) {
      draftOutputPath.value = obj.outputPath
    }
    return true
  }

  function snapshotExportSettings(): PersistedExportSettings {
    return {
      version: EXPORT_SETTINGS_VERSION,
      outputPath: draftOutputPath.value,
      format: draftFormat.value,
      sampleRate: draftSampleRate.value,
      bitDepth: draftBitDepth.value,
      dither: draftDither.value,
      tailSecondsText: draftTailSecondsText.value,
      bitrate: draftBitrate.value,
      loudnessPreset: draftLoudnessPreset.value,
      customTargetText: draftCustomTargetText.value,
      customCeilingText: draftCustomCeilingText.value,
      lengthMode: draftLengthMode.value,
      durationText: draftDurationText.value,
      title: draftTitle.value,
      artist: draftArtist.value,
      album: draftAlbum.value,
      year: draftYear.value,
      genre: draftGenre.value,
      comment: draftComment.value
    }
  }

  // ── Reseed on open ─────────────────────────────────────────────────────

  async function reseedOnOpen(): Promise<void> {
    submitting.value = false
    // Base defaults also fill fields omitted by persisted settings.
    draftFormat.value = 'wav'
    draftSampleRate.value = effectiveProjectRate.value
    draftBitDepth.value = 16
    draftDither.value = true
    draftTailSecondsText.value = '0'
    draftBitrate.value = 192
    draftLoudnessPreset.value = 'off'
    draftCustomTargetText.value = '-14'
    draftCustomCeilingText.value = '-1'
    draftLengthMode.value = 'fixed-duration'
    draftDurationText.value = formatTime(project.durationMs)
    draftMixdownStartBar.value = project.mixdownStartBar
    draftTitle.value = project.projectName?.trim() ?? ''
    draftArtist.value = ''
    draftAlbum.value = ''
    draftYear.value = ''
    draftGenre.value = ''
    draftComment.value = ''
    draftOutputPath.value = ''
    // Overlay whitelisted per-project settings.
    applyPersistedExportSettings(project.exportSettingsJson)
    // Derive a portable default path when none was restored.
    if (!draftOutputPath.value) {
      try {
        draftOutputPath.value = await window.silverdaw.resolveMixdownDefaultPath(
          project.currentFilePath ?? null,
          project.projectName ?? 'Untitled',
          draftFormat.value
        )
      } catch (err) {
        log.warn('mixdown', `resolveMixdownDefaultPath failed: ${String(err)}`)
        draftOutputPath.value = ''
      }
    }
  }

  // Keep the path extension in sync with the selected format.
  watch(draftFormat, () => {
    const path = draftOutputPath.value
    if (!path) return
    const replaced = path.replace(/\.[^.\\/]+$/, '')
    draftOutputPath.value = `${replaced}.${expectedFileExtension.value}`
  })

  // Snap unsupported bit-depths to the highest valid value for the format.
  watch(draftFormat, () => {
    const allowed = availableBitDepths.value
    if (allowed.length === 0) return
    if (!allowed.includes(draftBitDepth.value)) {
      const last = allowed[allowed.length - 1]
      if (last !== undefined) draftBitDepth.value = last
    }
  })

  // ── Actions ────────────────────────────────────────────────────────────

  async function onBrowseClick(): Promise<void> {
    const chosen = await window.silverdaw.chooseMixdownSaveAs(
      draftOutputPath.value,
      draftFormat.value
    )
    if (chosen) draftOutputPath.value = chosen
  }

  function onSave(): void {
    if (!formIsValid.value) return
    void doSave()
  }

  async function doSave(): Promise<void> {
    submitting.value = true
    try {
      // Normalise user-typed extensions to the selected format.
      let outputPath = draftOutputPath.value.trim()
      const expectedExt = `.${expectedFileExtension.value}`
      if (!outputPath.toLowerCase().endsWith(expectedExt)) {
        outputPath = `${outputPath.replace(/\.[^.\\/]+$/, '')}${expectedExt}`
      }

      const lengthMs = duration.value
      if (lengthMs <= 0) {
        notifications.pushError('Mixdown duration must be greater than zero.')
        return
      }

      // Confirm overwrites for manually edited paths and reflect any normalised extension.
      if (outputPath !== draftOutputPath.value.trim()) {
        draftOutputPath.value = outputPath
      }
      const overwrite = await window.silverdaw.confirmMixdownOverwrite(outputPath)
      if (overwrite === 'cancel') {
        log.info('mixdown', 'overwrite declined; staying on dialog')
        return
      }

      // File-level tags are mapped per format by the backend.
      const md = {
        title: draftTitle.value.trim() || undefined,
        artist: draftArtist.value.trim() || undefined,
        album: draftAlbum.value.trim() || undefined,
        year: draftYear.value.trim() || undefined,
        genre: draftGenre.value.trim() || undefined,
        comment: draftComment.value.trim() || undefined
      }
      const hasAnyTag = Object.values(md).some((v) => v !== undefined)

      log.info(
        'mixdown',
        `MIXDOWN_START dispatch path=${outputPath} format=${draftFormat.value} ` +
          `sr=${draftSampleRate.value} lengthMode=${draftLengthMode.value} lengthMs=${lengthMs}`
      )

      // Pre-pause so live playback cannot continue during the render.
      if (transport.isPlaying) {
        sendBridge('TRANSPORT_PAUSE')
        transport.setPlaybackState(false)
      }
      beginMixdown(outputPath, draftFormat.value)
      const payload: import('@shared/bridge-protocol').MixdownStartPayload = {
        outputPath,
        sampleRate: draftSampleRate.value,
        format: draftFormat.value,
        tailSeconds: tailSeconds.value,
        lengthMode: draftLengthMode.value,
        lengthMs
      }
      const startMs = mixdownStartMs.value
      if (startMs > 0) payload.startMs = startMs
      if (draftFormat.value === 'mp3') {
        payload.bitrateKbps = draftBitrate.value
      } else {
        payload.bitDepth = draftBitDepth.value
        payload.dither = draftDither.value
      }
      if (hasAnyTag) payload.metadata = md
      const loudness = buildLoudnessPayload()
      if (loudness) payload.loudness = loudness
      // Persist just before rendering so aborts still keep the user's export preferences.
      project.setExportSettingsJson(JSON.stringify(snapshotExportSettings()))
      // Persist the chosen start bar as a first-class project property (independent of the
      // ruler's bar-counter offset) so it round-trips and prefills next time.
      project.setMixdownStartBar(Math.round(draftMixdownStartBar.value))
      sendBridge('MIXDOWN_START', payload)
      deps.requestClose()
    } finally {
      submitting.value = false
    }
  }

  return {
    draftOutputPath,
    draftFormat,
    draftSampleRate,
    draftBitDepth,
    draftDither,
    draftTailSecondsText,
    draftBitrate,
    draftLoudnessPreset,
    draftCustomTargetText,
    draftCustomCeilingText,
    draftLengthMode,
    draftDurationText,
    draftMixdownStartBar,
    mixdownStartMs,
    draftTitle,
    draftArtist,
    draftAlbum,
    draftYear,
    draftGenre,
    draftComment,
    submitting,
    loudnessAvailable,
    customLoudnessActive,
    customTargetValid,
    customCeilingValid,
    loudnessValid,
    availableBitDepths,
    ditherApplies,
    tailValid,
    effectiveProjectRate,
    lastClipEndMs,
    duration,
    durationValid,
    pathValid,
    formIsValid,
    expectedFileExtension,
    reseedOnOpen,
    onBrowseClick,
    onSave
  }
}
