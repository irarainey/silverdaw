<script setup lang="ts">
// Export Mixdown dialog.
//
// Renders the file save location, format, sample rate, length policy
// and (for MP3 only) the ID3v2 metadata fields. Submitting builds a
// `MIXDOWN_START` envelope and hands the dialog over to the
// `MixdownProgressDialog` mounted at App level.
//
// MP3 export is wired all the way through the protocol but the radio
// is currently disabled — the backend's encoder integration lands in a
// focused follow-up turn. The greyed-out tooltip explains.
//
// Transactional: all fields are local refs. Cancel / Esc discard.

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { beginMixdown } from '@/lib/mixdownState'
import { formatTime, parseTime } from '@/lib/musicTime'
import { effectiveClipDurationMs } from '@/stores/projectStore'
import { log } from '@/lib/log'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()
const transport = useTransportStore()
const ui = useUiStore()
const notifications = useNotificationsStore()

const dialogEl = ref<HTMLDivElement | null>(null)

// ── Draft fields ───────────────────────────────────────────────────────
const draftOutputPath = ref('')
const draftFormat = ref<'wav' | 'mp3' | 'flac' | 'aiff'>('wav')
const draftSampleRate = ref<44100 | 48000>(44100)
const draftBitDepth = ref<16 | 24 | 32>(16)
const draftDither = ref<boolean>(true)
/** Tail-seconds field as text so the user can edit naturally; parsed
 *  to a number on submit. Empty / blank means "no tail". */
const draftTailSecondsText = ref('0')
const draftBitrate = ref<128 | 192 | 320>(192)
// ── Loudness / normalization ───────────────────────────────────────────
/** Loudness preset. `off` is no analysis (default), four normalization
 *  presets cover the dominant delivery targets (Spotify / Apple / EBU
 *  R128). `analyze` measures only and writes byte-identical output to
 *  `off`. `custom` reveals the target + ceiling inputs. */
type LoudnessPreset = 'off' | 'streaming-14' | 'apple-16' | 'broadcast-23' | 'analyze' | 'custom'
const draftLoudnessPreset = ref<LoudnessPreset>('off')
const draftCustomTargetText = ref('-14')
const draftCustomCeilingText = ref('-1')
/** Loudness modes require a standard sample rate. Disable the controls
 *  with a tooltip when the user has somehow ended up off-rate (today
 *  not reachable because the SR radio only offers 44.1/48, but the
 *  guard documents the requirement). */
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
/** Map preset → MIXDOWN_START loudness block. `off` → undefined so
 *  the payload omits the field entirely (the backend defaults to off). */
function buildLoudnessPayload(): {
  mode: 'off' | 'analyze' | 'normalize'
  targetLufs?: number
  ceilingDbtp?: number
} | undefined {
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
// File-level tags — all optional, written to every format.
const draftTitle = ref('')
const draftArtist = ref('')
const draftAlbum = ref('')
const draftYear = ref('')
const draftGenre = ref('')
const draftComment = ref('')

const submitting = ref(false)

// ── Derived ────────────────────────────────────────────────────────────

/** Bit-depth choices that are valid for the currently-selected format.
 *  - WAV supports 16 / 24 (PCM) and 32 (IEEE float).
 *  - FLAC supports 16 / 24.
 *  - MP3 ignores bit-depth (lossy psychoacoustic encoding). We hide
 *    the row entirely in that case via `v-if`. */
const availableBitDepths = computed<readonly (16 | 24 | 32)[]>(() => {
  if (draftFormat.value === 'flac') return [16, 24] as const
  if (draftFormat.value === 'aiff') return [16, 24] as const
  if (draftFormat.value === 'wav') return [16, 24, 32] as const
  return [] as const
})

/** TPDF dither only meaningfully affects 16-bit integer outputs. We
 *  surface the checkbox only when it does something; for 24-bit the
 *  noise floor is already below audibility, and 32-float has no
 *  quantisation step. */
const ditherApplies = computed<boolean>(
  () =>
    draftFormat.value !== 'mp3' &&
    draftBitDepth.value === 16
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

/** Effective project sample rate, mirroring the fallback used elsewhere:
 *  project-level value if set, otherwise the user-scope default. */
const effectiveProjectRate = computed<44100 | 48000>(() => {
  const projectRate = project.targetSampleRate
  if (projectRate === 44100 || projectRate === 48000) return projectRate
  const fallback = ui.defaultProjectSampleRate
  return fallback === 48000 ? 48000 : 44100
})

/** Timeline end (ms) of the latest-ending clip, accounting for warp.
 *  Used by the "trim to last clip" option. */
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

const pathValid = computed<boolean>(
  () => typeof draftOutputPath.value === 'string' && draftOutputPath.value.trim().length > 0
)

const formIsValid = computed<boolean>(
  () => pathValid.value && durationValid.value && tailValid.value && loudnessValid.value && !submitting.value
)

const expectedFileExtension = computed(() =>
  draftFormat.value === 'mp3'
    ? 'mp3'
    : draftFormat.value === 'flac'
      ? 'flac'
      : draftFormat.value === 'aiff'
        ? 'aiff'
        : 'wav'
)

// ── Persisted export settings (project level) ─────────────────────────
//
// The export dialog stores its last-used settings + metadata as an
// opaque JSON blob on the project root (`exportSettingsJson`). The
// schema is owned here in the renderer — backend round-trips the
// string verbatim, including via `.silverdaw` save/load. On open we
// parse and apply with a per-field whitelist + clamp so a malformed
// or future-version blob can't crash the dialog. On submit we
// serialize the current drafts and dispatch
// `PROJECT_SET_EXPORT_SETTINGS` immediately before MIXDOWN_START.
//
// Notes:
//  • `outputPath` is intentionally NOT persisted — always re-derived
//    from the project file location so projects stay portable.
//  • Parse failure leaves the existing backend blob untouched (a
//    future build that understands a newer version can still read it).
const EXPORT_SETTINGS_VERSION = 1 as const

type ExportFormat = 'wav' | 'mp3' | 'flac' | 'aiff'

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

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    submitting.value = false
    // Step 1: base defaults. These apply when there is no persisted
    // blob on the project (fresh project) and act as the fallback for
    // any individual field a persisted blob omits.
    draftFormat.value = 'wav'
    draftSampleRate.value = effectiveProjectRate.value
    draftBitDepth.value = 16
    draftDither.value = true
    draftTailSecondsText.value = '0'
    draftBitrate.value = 192
    draftLoudnessPreset.value = 'off'
    draftCustomTargetText.value = '-14'
    draftCustomCeilingText.value = '-1'
    // Default length = project duration (rubber-duck finding).
    draftLengthMode.value = 'fixed-duration'
    draftDurationText.value = formatTime(project.durationMs)
    draftTitle.value = project.projectName?.trim() ?? ''
    draftArtist.value = ''
    draftAlbum.value = ''
    draftYear.value = ''
    draftGenre.value = ''
    draftComment.value = ''
    draftOutputPath.value = ''
    // Step 2: overlay any persisted per-project settings. Whitelist
    // each field; a parse failure or unrecognised version leaves the
    // base defaults in place AND leaves the bad blob untouched on the
    // backend so a future build can still read it. This also
    // restores `draftOutputPath` if a path was stored.
    applyPersistedExportSettings(project.exportSettingsJson)
    // Step 3: if no path was restored (fresh project, or persisted
    // blob lacked `outputPath`), derive one from the project file
    // location: <projectDir>/mixdown/<name>.<ext>.
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
  },
  { immediate: true }
)

// Keep extension in sync with the format radio so a user who picked a
// path then switched format doesn't get a wav-with-.mp3-extension.
watch(draftFormat, () => {
  const path = draftOutputPath.value
  if (!path) return
  const replaced = path.replace(/\.[^.\\/]+$/, '')
  draftOutputPath.value = `${replaced}.${expectedFileExtension.value}`
})

// If the user picks a format that doesn't support the currently-
// selected bit-depth (e.g. they had 32-bit float WAV selected then
// switch to FLAC, which only supports 16/24), snap to the highest
// supported value rather than silently sending an invalid combo
// that the backend would reject.
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

function onClose(): void {
  emit('close')
}

function onSave(): void {
  if (!formIsValid.value) return
  void doSave()
}

async function doSave(): Promise<void> {
  submitting.value = true
  try {
    // Normalise extension to match the format radio in case the user
    // typed a different one.
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

    // Overwrite confirmation: prompt before dispatching when the
    // target file already exists. The native Save As dialog handles
    // this for Browse-picked paths, but a user who edited the path
    // field directly bypasses that — this is the belt-and-braces
    // check. Reflect any normalised extension back into the field
    // so the user can see what they're being asked to overwrite.
    if (outputPath !== draftOutputPath.value.trim()) {
      draftOutputPath.value = outputPath
    }
    const overwrite = await window.silverdaw.confirmMixdownOverwrite(outputPath)
    if (overwrite === 'cancel') {
      // Keep the dialog open so the user can edit the filename.
      log.info('mixdown', 'overwrite declined; staying on dialog')
      return
    }

    // File-level tags apply to every format (mapped per-format by the
    // backend to ID3v2 / RIFF INFO / VORBIS_COMMENT / AIFF text chunks).
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

    // Transport must be stopped before the render begins so audio
    // doesn't play live during the mix. The backend rejects
    // TRANSPORT_PLAY while busy, but pre-pausing keeps the UI honest.
    if (transport.isPlaying) {
      sendBridge('TRANSPORT_PAUSE')
      transport.setPlaybackState(false)
    }
    // Begin tracking the render so MixdownProgressDialog mounts.
    beginMixdown(outputPath, draftFormat.value)
    const payload: import('@shared/bridge-protocol').MixdownStartPayload = {
      outputPath,
      sampleRate: draftSampleRate.value,
      format: draftFormat.value,
      tailSeconds: tailSeconds.value,
      lengthMode: draftLengthMode.value,
      lengthMs
    }
    if (draftFormat.value === 'mp3') {
      payload.bitrateKbps = draftBitrate.value
    } else {
      payload.bitDepth = draftBitDepth.value
      payload.dither = draftDither.value
    }
    if (hasAnyTag) payload.metadata = md
    const loudness = buildLoudnessPayload()
    if (loudness) payload.loudness = loudness
    // Persist the current settings + metadata on the project so the
    // next time this project is opened the dialog reopens to the same
    // state. Dispatched immediately before MIXDOWN_START so a render
    // that aborts on the backend still leaves the user's preferences
    // saved. Not undoable.
    project.setExportSettingsJson(JSON.stringify(snapshotExportSettings()))
    sendBridge('MIXDOWN_START', payload)
    emit('close')
  } finally {
    submitting.value = false
  }
}

// ── Keyboard ───────────────────────────────────────────────────────────

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    onClose()
    return
  }
  if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
    if (formIsValid.value) {
      e.preventDefault()
      onSave()
    }
  }
}

function focusDialog(): void {
  dialogEl.value?.focus()
}

watch(() => props.open, (open) => { if (open) requestAnimationFrame(focusDialog) })

onBeforeUnmount(() => {
  // Nothing persistent — drafts live in component refs.
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-mixdown-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(760px,92vw)]"
        @keydown="onKeydown"
      >
        <div class="dialog-header">
          <h1
            id="export-mixdown-title"
            class="dialog-title"
          >
            Export mixdown
          </h1>
        </div>

        <div class="dialog-body silverdaw-scroll">
          <!-- Output location -->
          <section class="mb-5">
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Output file
            </label>
            <div class="flex gap-2">
              <input
                v-model="draftOutputPath"
                type="text"
                spellcheck="false"
                class="flex-1 min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-500"
              >
              <button
                type="button"
                class="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700"
                @click="onBrowseClick"
              >
                Browse…
              </button>
            </div>
          </section>

          <!-- Format / Sample rate / Bit depth row -->
          <section class="mb-5 grid grid-cols-3 gap-3">
            <div>
              <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Format
              </label>
              <select
                v-model="draftFormat"
                class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500"
              >
                <option value="wav">
                  WAV (PCM / float)
                </option>
                <option value="flac">
                  FLAC (lossless)
                </option>
                <option value="aiff">
                  AIFF (lossless)
                </option>
                <option value="mp3">
                  MP3 (lossy, 16-bit)
                </option>
              </select>
            </div>
            <div>
              <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Sample rate
              </label>
              <select
                v-model.number="draftSampleRate"
                class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500"
              >
                <option :value="44100">
                  44.1 kHz
                </option>
                <option :value="48000">
                  48 kHz
                </option>
              </select>
              <p class="mt-1 text-[10px] text-zinc-500">
                Project rate: {{ (effectiveProjectRate / 1000).toFixed(1) }} kHz
              </p>
            </div>
            <div v-if="draftFormat === 'mp3'">
              <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Bitrate
              </label>
              <select
                v-model.number="draftBitrate"
                class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500"
              >
                <option
                  v-for="kbps in [128, 192, 320] as const"
                  :key="kbps"
                  :value="kbps"
                >
                  {{ kbps }} kbps
                </option>
              </select>
            </div>
            <div v-else>
              <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Bit depth
              </label>
              <select
                v-model.number="draftBitDepth"
                class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500"
              >
                <option
                  v-for="bd in availableBitDepths"
                  :key="bd"
                  :value="bd"
                >
                  {{ bd }}-bit{{ bd === 32 && draftFormat === 'wav' ? ' float' : '' }}
                </option>
              </select>
              <label
                v-if="ditherApplies"
                class="mt-1 flex cursor-pointer items-center gap-1.5"
                title="TPDF dither randomises the quantisation error to remove harmonic distortion at 16-bit. Recommended ON."
              >
                <input
                  v-model="draftDither"
                  type="checkbox"
                  class="accent-cyan-500"
                >
                <span class="text-[10px] text-zinc-400">Dither</span>
              </label>
            </div>
          </section>

          <!-- Loudness / normalization -->
          <section
            class="mb-5"
            :title="loudnessAvailable ? '' : 'Loudness analysis requires 44.1 or 48 kHz output.'"
          >
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Loudness
            </label>
            <select
              v-model="draftLoudnessPreset"
              :disabled="!loudnessAvailable"
              class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="off">
                None &ndash; export as-is
              </option>
              <option value="streaming-14">
                Streaming &minus;14 LUFS (Spotify, YouTube, SoundCloud, Tidal, Amazon)
              </option>
              <option value="apple-16">
                Apple Music &minus;16 LUFS
              </option>
              <option value="broadcast-23">
                EBU R128 / AES Broadcast &minus;23 LUFS
              </option>
              <option value="analyze">
                Analyze only (measure, no gain change)
              </option>
              <option value="custom">
                Custom target&hellip;
              </option>
            </select>
            <div class="flex flex-col gap-1.5 text-xs">
              <div
                v-if="customLoudnessActive"
                class="mt-2 flex flex-wrap items-center gap-3"
              >
                <label class="flex items-center gap-1.5">
                  <span class="text-zinc-400">Target LUFS</span>
                  <input
                    v-model="draftCustomTargetText"
                    type="number"
                    step="0.1"
                    min="-30"
                    max="-6"
                    class="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5"
                    :class="{ 'border-red-500': !customTargetValid }"
                  >
                </label>
                <label class="flex items-center gap-1.5">
                  <span class="text-zinc-400">Ceiling dBTP</span>
                  <input
                    v-model="draftCustomCeilingText"
                    type="number"
                    step="0.1"
                    min="-9"
                    max="0"
                    class="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5"
                    :class="{ 'border-red-500': !customCeilingValid }"
                  >
                </label>
                <span class="text-[10px] text-zinc-500">
                  Range: target [-30, -6] LUFS, ceiling [-9, 0] dBTP.
                </span>
              </div>
            </div>
          </section>

          <!-- MP3 bitrate now lives in the Format/Sample rate/Bitrate row above. -->

          <!-- Length policy -->
          <section class="mb-5">
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Length
            </label>
            <div class="space-y-2">
              <label class="flex cursor-pointer items-center gap-1.5">
                <input
                  v-model="draftLengthMode"
                  type="radio"
                  value="fixed-duration"
                  class="accent-cyan-500"
                >
                <span>Clip at duration</span>
                <input
                  v-model="draftDurationText"
                  type="text"
                  spellcheck="false"
                  :disabled="draftLengthMode !== 'fixed-duration'"
                  class="ml-2 w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
              </label>
              <label class="flex cursor-pointer items-center gap-1.5">
                <input
                  v-model="draftLengthMode"
                  type="radio"
                  value="trim-to-last-clip"
                  class="accent-cyan-500"
                >
                <span>Trim to end of last clip</span>
                <span
                  v-if="draftLengthMode === 'trim-to-last-clip'"
                  class="ml-2 font-mono text-[11px] text-zinc-500"
                >({{ formatTime(lastClipEndMs) }})</span>
              </label>
            </div>
          </section>

          <!-- Tail seconds -->
          <section class="mb-5">
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Tail
            </label>
            <div class="flex items-center gap-2">
              <input
                v-model="draftTailSecondsText"
                type="text"
                spellcheck="false"
                inputmode="decimal"
                class="w-20 rounded border px-2 py-0.5 font-mono text-xs text-zinc-100 outline-none focus:border-cyan-500"
                :class="tailValid
                  ? 'border-zinc-700 bg-zinc-950'
                  : 'border-rose-600 bg-zinc-950'"
              >
              <span class="text-xs text-zinc-400">seconds of silence after the timeline</span>
            </div>
            <p class="mt-1 text-[10px] text-zinc-500">
              Lets reverb / delay clips ring out past the timeline end. Range 0–60 s.
            </p>
          </section>

          <!-- File-level tags (all formats; always visible) -->
          <section class="mb-2 rounded border border-zinc-800 bg-zinc-950/60">
            <header
              class="flex items-center justify-between px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-500"
            >
              <span>Tags (optional)</span>
            </header>
            <div class="grid grid-cols-2 gap-2 px-3 pb-3 text-xs">
              <label class="flex flex-col gap-0.5">
                <span class="text-zinc-500">Title</span>
                <input
                  v-model="draftTitle"
                  type="text"
                  class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-cyan-500"
                >
              </label>
              <label class="flex flex-col gap-0.5">
                <span class="text-zinc-500">Artist</span>
                <input
                  v-model="draftArtist"
                  type="text"
                  class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-cyan-500"
                >
              </label>
              <label class="flex flex-col gap-0.5">
                <span class="text-zinc-500">Album</span>
                <input
                  v-model="draftAlbum"
                  type="text"
                  class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-cyan-500"
                >
              </label>
              <label class="flex flex-col gap-0.5">
                <span class="text-zinc-500">Year</span>
                <input
                  v-model="draftYear"
                  type="text"
                  inputmode="numeric"
                  class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-cyan-500"
                >
              </label>
              <label class="flex flex-col gap-0.5">
                <span class="text-zinc-500">Genre</span>
                <input
                  v-model="draftGenre"
                  type="text"
                  class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-cyan-500"
                >
              </label>
              <label class="col-span-2 flex flex-col gap-0.5">
                <span class="text-zinc-500">Comment</span>
                <input
                  v-model="draftComment"
                  type="text"
                  class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-cyan-500"
                >
              </label>
            </div>
          </section>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onClose"
          >
            Cancel
          </button>
          <button
            type="button"
            :disabled="!formIsValid"
            class="dialog-btn-primary"
            @click="onSave"
          >
            Export
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
