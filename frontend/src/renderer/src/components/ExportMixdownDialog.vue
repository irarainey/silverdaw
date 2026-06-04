<script setup lang="ts">
// Export Mixdown dialog.
//
// Renders the file save location, format, sample rate, length policy
// and the file-level metadata fields. Submitting builds a
// `MIXDOWN_START` envelope and hands the dialog over to the
// `MixdownProgressDialog` mounted at App level. The transactional form
// model (drafts, validation, persistence, submit) lives in
// `useExportMixdownForm`; this component owns presentation, keyboard,
// focus and lifecycle only.

import { ref, watch } from 'vue'
import { formatTime } from '@/lib/musicTime'
import { useExportMixdownForm } from '@/lib/export/useExportMixdownForm'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = ref<HTMLDivElement | null>(null)

const {
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
  draftTitle,
  draftArtist,
  draftAlbum,
  draftYear,
  draftGenre,
  draftComment,
  loudnessAvailable,
  customLoudnessActive,
  customTargetValid,
  customCeilingValid,
  availableBitDepths,
  ditherApplies,
  tailValid,
  effectiveProjectRate,
  lastClipEndMs,
  formIsValid,
  reseedOnOpen,
  onBrowseClick,
  onSave
} = useExportMixdownForm({ requestClose: () => emit('close') })

function onClose(): void {
  emit('close')
}

// ── Reseed on open ─────────────────────────────────────────────────────
watch(
  () => props.open,
  (open) => {
    if (open) void reseedOnOpen()
  },
  { immediate: true }
)

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

watch(
  () => props.open,
  (open) => {
    if (open) requestAnimationFrame(focusDialog)
  }
)
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
