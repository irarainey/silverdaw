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
const draftFormat = ref<'wav' | 'mp3' | 'flac'>('wav')
const draftSampleRate = ref<44100 | 48000>(44100)
const draftBitDepth = ref<16 | 24 | 32>(16)
const draftDither = ref<boolean>(true)
/** Tail-seconds field as text so the user can edit naturally; parsed
 *  to a number on submit. Empty / blank means "no tail". */
const draftTailSecondsText = ref('0')
const draftBitrate = ref<128 | 192 | 320>(192)
const draftLengthMode = ref<'trim-to-last-clip' | 'fixed-duration'>('fixed-duration')
const draftDurationText = ref('')
// MP3 metadata — all optional.
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
  if (draftFormat.value === 'wav') return [16, 24, 32] as const
  return [] as const
})

/** TPDF dither only meaningfully affects 16-bit integer outputs. We
 *  surface the checkbox only when it does something; for 24-bit the
 *  noise floor is already below audibility, and 32-float has no
 *  quantisation step. */
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
  () => pathValid.value && durationValid.value && tailValid.value && !submitting.value
)

const expectedFileExtension = computed(() =>
  draftFormat.value === 'mp3' ? 'mp3' : draftFormat.value === 'flac' ? 'flac' : 'wav'
)

// ── Reseed on open ─────────────────────────────────────────────────────

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    submitting.value = false
    // Seed format from prior session preference (sticky within the
    // session via uiStore in a future iteration; default WAV today).
    draftFormat.value = 'wav'
    draftSampleRate.value = effectiveProjectRate.value
    draftBitDepth.value = 16
    draftDither.value = true
    draftTailSecondsText.value = '0'
    draftBitrate.value = 192
    // Default length = project duration (rubber-duck finding).
    draftLengthMode.value = 'fixed-duration'
    draftDurationText.value = formatTime(project.durationMs)
    draftTitle.value = project.projectName?.trim() ?? ''
    draftArtist.value = ''
    draftAlbum.value = ''
    draftYear.value = ''
    draftGenre.value = ''
    draftComment.value = ''
    // Default path comes from main IPC: <projectDir>/mixdown/<name>.<ext>
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
  },
  { immediate: true }
)

// Keep extension in sync with the format radio so a user who picked a
// path then switched format doesn't get a wav-with-.mp3-extension.
watch(draftFormat, (fmt) => {
  const path = draftOutputPath.value
  if (!path) return
  const replaced = path.replace(/\.[^.\\/]+$/, '')
  draftOutputPath.value = `${replaced}.${fmt}`
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

    const md =
      draftFormat.value === 'mp3'
        ? {
            title: draftTitle.value.trim() || undefined,
            artist: draftArtist.value.trim() || undefined,
            album: draftAlbum.value.trim() || undefined,
            year: draftYear.value.trim() || undefined,
            genre: draftGenre.value.trim() || undefined,
            comment: draftComment.value.trim() || undefined
          }
        : undefined

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
      if (md) payload.mp3Metadata = md
    } else {
      payload.bitDepth = draftBitDepth.value
      payload.dither = draftDither.value
    }
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
        class="dialog-card w-[min(560px,92vw)]"
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

        <div class="dialog-body">
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

          <!-- Format -->
          <section class="mb-5">
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Format
            </label>
            <div class="flex gap-4">
              <label class="flex cursor-pointer items-center gap-1.5">
                <input
                  v-model="draftFormat"
                  type="radio"
                  value="wav"
                  class="accent-cyan-500"
                >
                <span>WAV<span class="ml-1 text-[10px] text-zinc-500">(PCM / float)</span></span>
              </label>
              <label class="flex cursor-pointer items-center gap-1.5">
                <input
                  v-model="draftFormat"
                  type="radio"
                  value="flac"
                  class="accent-cyan-500"
                >
                <span>FLAC<span class="ml-1 text-[10px] text-zinc-500">(lossless)</span></span>
              </label>
              <label
                class="flex cursor-not-allowed items-center gap-1.5 text-zinc-500"
                title="MP3 export ships in a follow-up update once the LAME encoder is integrated."
              >
                <input
                  type="radio"
                  value="mp3"
                  disabled
                  class="accent-cyan-500"
                >
                <span>MP3 <span class="text-[10px]">(coming soon)</span></span>
              </label>
            </div>
          </section>

          <!-- Bit depth (hidden for MP3) -->
          <section
            v-if="draftFormat !== 'mp3'"
            class="mb-5"
          >
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Bit depth
            </label>
            <div class="flex flex-wrap items-center gap-4">
              <label
                v-for="bd in availableBitDepths"
                :key="bd"
                class="flex cursor-pointer items-center gap-1.5"
              >
                <input
                  v-model.number="draftBitDepth"
                  type="radio"
                  :value="bd"
                  class="accent-cyan-500"
                >
                <span>
                  {{ bd }}-bit
                  <span
                    v-if="bd === 32 && draftFormat === 'wav'"
                    class="text-[10px] text-zinc-500"
                  >float</span>
                </span>
              </label>
              <label
                v-if="ditherApplies"
                class="ml-2 flex cursor-pointer items-center gap-1.5"
                title="TPDF dither randomises the quantisation error to remove harmonic distortion at 16-bit. Recommended ON."
              >
                <input
                  v-model="draftDither"
                  type="checkbox"
                  class="accent-cyan-500"
                >
                <span class="text-xs">Dither</span>
              </label>
            </div>
          </section>

          <!-- Sample rate -->
          <section class="mb-5">
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Sample rate
            </label>
            <div class="flex gap-4">
              <label class="flex cursor-pointer items-center gap-1.5">
                <input
                  v-model.number="draftSampleRate"
                  type="radio"
                  :value="44100"
                  class="accent-cyan-500"
                >
                <span>44.1 kHz</span>
              </label>
              <label class="flex cursor-pointer items-center gap-1.5">
                <input
                  v-model.number="draftSampleRate"
                  type="radio"
                  :value="48000"
                  class="accent-cyan-500"
                >
                <span>48 kHz</span>
              </label>
              <span class="text-[10px] text-zinc-500">
                Project rate: {{ (effectiveProjectRate / 1000).toFixed(1) }} kHz
              </span>
            </div>
          </section>

          <!-- MP3 bitrate (hidden when WAV) -->
          <section
            v-if="draftFormat === 'mp3'"
            class="mb-5"
          >
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              MP3 bitrate
            </label>
            <div class="flex gap-4">
              <label
                v-for="kbps in [128, 192, 320] as const"
                :key="kbps"
                class="flex cursor-pointer items-center gap-1.5"
              >
                <input
                  v-model.number="draftBitrate"
                  type="radio"
                  :value="kbps"
                  class="accent-cyan-500"
                >
                <span>{{ kbps }} kbps</span>
              </label>
            </div>
          </section>

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

          <!-- MP3 metadata (hidden when WAV) -->
          <section
            v-if="draftFormat === 'mp3'"
            class="mb-2 rounded border border-zinc-800 bg-zinc-950/60 p-3"
          >
            <div class="mb-2 text-[11px] uppercase tracking-wide text-zinc-500">
              MP3 metadata (optional)
            </div>
            <div class="grid grid-cols-2 gap-2 text-xs">
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
