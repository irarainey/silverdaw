<script setup lang="ts">
// Per-clip warp/pitch settings dialog. Opens from the timeline clip context menu.
//
// Surface:
//
//   ┌───────────────────────────────────────┐
//   │ Warp — <clip name>                    │
//   │  [✔] Warp enabled                     │
//   │   Mode    ( rhythmic / tonal /        │
//   │             complex )                 │
//   │   Tempo   ( ◯ follow project BPM      │
//   │              ◯ pin to ___ BPM )       │
//   └───────────────────────────────────────┘
//
// Edits are held locally until Save. Cancel / Escape / backdrop close discard
// the draft so the dialog behaves like the rest of the app's modal editors.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { effectiveTempoRatio } from '@/lib/warp'
import type { ClipWarpMode } from '@shared/bridge-protocol'

const props = withDefaults(defineProps<{
  open: boolean
  clipId: string | null
  panel?: 'tempo' | 'pitch'
}>(), { panel: 'tempo' })
const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()
const library = useLibraryStore()
const transport = useTransportStore()
const ui = useUiStore()

const dialogEl = ref<HTMLDivElement | null>(null)

const clip = computed(() => (props.clipId ? project.clips[props.clipId] : undefined))
const libItem = computed(() =>
  clip.value ? library.items.find((i) => i.id === clip.value!.libraryItemId) : undefined
)

const sourceBpm = computed(() => libItem.value?.bpm)
const projectBpm = computed(() => transport.bpm)
const dialogTitle = computed(() => props.panel === 'pitch' ? 'Pitch' : 'Warp')

const draftEnabled = ref(false)
const draftMode = ref<ClipWarpMode>('rhythmic')
const draftTempoPinned = ref(false)
const draftPinnedBpm = ref(120)
const draftSemitones = ref(0)
const draftCents = ref(0)

// Tempo source: either "follow project BPM" (no `tempoRatio` on the
// clip) or "pin to a specific source BPM" (`tempoRatio` is set).
const tempoFollowsProject = computed(() => !draftTempoPinned.value)

/** When pinned, the BPM the clip plays AT — derived from `tempoRatio`
 *  and the source BPM via `pinnedBpm = sourceBpm * tempoRatio`. We
 *  surface BPM rather than ratio in the UI because the user thinks
 *  in tempos, not in stretch factors. */
function followProjectBpm(): void {
  draftTempoPinned.value = false
}

function pinTempo(): void {
  const src = sourceBpm.value
  const proj = projectBpm.value
  if (typeof src !== 'number' || src <= 0 || typeof proj !== 'number' || proj <= 0) return
  // Pin at the current effective ratio (which is `projectBpm/sourceBpm`
  // if not already pinned) so flipping the toggle on doesn't audibly
  // change anything until the user moves the slider.
  draftTempoPinned.value = true
  if (!Number.isFinite(draftPinnedBpm.value) || draftPinnedBpm.value <= 0) {
    draftPinnedBpm.value = Math.round(proj * 100) / 100
  }
}

function resetPitch(): void {
  draftSemitones.value = 0
  draftCents.value = 0
}

function pitchNeedsProcessor(semitonesValue: number, centsValue: number): boolean {
  return semitonesValue !== 0 || centsValue !== 0
}

const effectiveRatio = computed(() =>
  effectiveTempoRatio({
    tempoRatio: draftTempoPinned.value ? tempoRatioFromPinnedBpm() : undefined,
    sourceBpm: sourceBpm.value,
    projectBpm: projectBpm.value
  })
)

const effectiveBpm = computed(() => {
  const src = sourceBpm.value
  if (typeof src !== 'number' || src <= 0) return null
  return Math.round(src * effectiveRatio.value * 100) / 100
})

function clampNumber(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(lo, Math.min(hi, v))
}

function tempoRatioFromPinnedBpm(): number | undefined {
  const src = sourceBpm.value
  if (typeof src !== 'number' || src <= 0) return undefined
  const bpm = clampNumber(draftPinnedBpm.value, 20, 300)
  return Math.max(0.25, Math.min(4, bpm / src))
}

function initialiseDraft(): void {
  const c = clip.value
  draftEnabled.value = c?.warpEnabled === true
  draftMode.value = c?.warpMode ?? 'rhythmic'
  draftTempoPinned.value = typeof c?.tempoRatio === 'number' && c.tempoRatio > 0
  const src = sourceBpm.value
  if (draftTempoPinned.value && typeof src === 'number' && src > 0 && typeof c?.tempoRatio === 'number') {
    draftPinnedBpm.value = Math.round(src * c.tempoRatio * 100) / 100
  } else {
    draftPinnedBpm.value = Math.round((projectBpm.value ?? 120) * 100) / 100
  }
  draftSemitones.value = c?.semitones ?? 0
  draftCents.value = c?.cents ?? 0
}

function save(): void {
  if (!props.clipId) return
  if (props.panel === 'tempo') {
    project.setClipWarp(props.clipId, {
      warpEnabled: draftEnabled.value,
      warpMode: draftMode.value,
      tempoRatio: draftTempoPinned.value ? tempoRatioFromPinnedBpm() : null
    })
  } else {
    const nextSemitones = clampNumber(draftSemitones.value, -12, 12)
    const nextCents = clampNumber(draftCents.value, -100, 100)
    project.setClipWarp(props.clipId, {
      semitones: nextSemitones,
      cents: nextCents,
      warpEnabled: pitchNeedsProcessor(nextSemitones, nextCents) ? true : undefined
    })
  }
  emit('close')
}

function cancel(): void {
  emit('close')
}

// Suppress global Spacebar play / Esc handlers while the dialog is open.
// Same plumbing the Clip Editor uses; we lean on it to keep slider
// drags from accidentally toggling playback.
watch(
  () => props.open,
  (now) => {
    ui.clipEditorOpen = now
    if (now) {
      initialiseDraft()
      void dialogEl.value?.focus()
    }
  }
)

watch(
  () => [props.clipId, props.panel] as const,
  () => {
    if (props.open) initialiseDraft()
  }
)

onMounted(() => {
  if (props.open) ui.clipEditorOpen = true
})

onBeforeUnmount(() => {
  if (props.open) ui.clipEditorOpen = false
})

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.preventDefault()
    cancel()
  }
}
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-100"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open && clip"
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clip-warp-title"
      @click.self="cancel"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex w-[min(440px,92vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
        @keydown="onKeydown"
      >
        <!-- Header -->
        <div class="flex items-baseline justify-between border-b border-zinc-800 px-5 py-3">
          <h1
            id="clip-warp-title"
            class="truncate text-sm font-semibold tracking-tight text-zinc-100"
          >
            {{ dialogTitle }}
            <span class="ml-2 truncate text-xs font-normal text-zinc-500">
              {{ clip.name || libItem?.name || libItem?.fileName || 'clip' }}
            </span>
          </h1>
          <button
            type="button"
            data-borderless-button="true"
            class="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            title="Close"
            @click="cancel"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="h-3.5 w-3.5"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <!-- Body -->
        <div class="flex flex-col gap-4 px-5 py-4 text-xs">
          <!-- Enabled toggle -->
          <label class="flex items-center gap-2 text-zinc-200">
            <template v-if="panel === 'tempo'">
              <input
                v-model="draftEnabled"
                type="checkbox"
                class="h-3.5 w-3.5 cursor-pointer"
              >
              <span class="font-medium">Enable warp</span>
              <span class="text-zinc-500">
                ({{ draftEnabled ? 'on' : 'bypassed' }})
              </span>
            </template>
            <template v-else>
              <span class="font-medium">Pitch shift</span>
              <span class="text-zinc-500">changes pitch without changing clip timing</span>
            </template>
          </label>

          <!-- Source / project BPM readout -->
          <div
            v-if="panel === 'tempo'"
            class="grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-zinc-400"
          >
            <div>
              <div class="text-[10px] uppercase tracking-wider text-zinc-500">
                Source BPM
              </div>
              <div class="font-mono text-zinc-200">
                {{ sourceBpm ? sourceBpm.toFixed(2) : '—' }}
              </div>
            </div>
            <div>
              <div class="text-[10px] uppercase tracking-wider text-zinc-500">
                Effective BPM
              </div>
              <div class="font-mono text-zinc-200">
                {{ effectiveBpm !== null ? effectiveBpm.toFixed(2) : '—' }}
                <span class="ml-1 text-[10px] text-zinc-500">
                  ({{ effectiveRatio.toFixed(2) }}×)
                </span>
              </div>
            </div>
          </div>

          <!-- Mode picker -->
          <fieldset
            v-if="panel === 'tempo'"
            class="flex flex-col gap-1"
            :disabled="!draftEnabled"
            :class="!draftEnabled ? 'opacity-50' : ''"
          >
            <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
              Mode
            </legend>
            <div class="flex gap-1">
              <button
                v-for="m in (['rhythmic', 'tonal', 'complex'] as ClipWarpMode[])"
                :key="m"
                type="button"
                class="flex-1 rounded border px-2 py-1 text-xs capitalize transition-colors"
                :class="draftMode === m
                  ? 'border-sky-500 bg-sky-600/30 text-zinc-100'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                "
                @click="draftMode = m"
              >
                {{ m }}
              </button>
            </div>
          </fieldset>

          <!-- Tempo source -->
          <fieldset
            v-if="panel === 'tempo'"
            class="flex flex-col gap-1"
            :disabled="!draftEnabled || !sourceBpm"
            :class="!draftEnabled || !sourceBpm ? 'opacity-50' : ''"
          >
            <legend class="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
              Tempo
            </legend>
            <label class="flex items-center gap-2">
              <input
                type="radio"
                :checked="tempoFollowsProject"
                @change="followProjectBpm()"
              >
              <span class="text-zinc-200">Follow project BPM</span>
              <span class="ml-auto text-[10px] text-zinc-500">
                ({{ projectBpm.toFixed(2) }})
              </span>
            </label>
            <label class="flex items-center gap-2">
              <input
                type="radio"
                :checked="!tempoFollowsProject"
                @change="pinTempo()"
              >
              <span class="text-zinc-200">Pin to</span>
              <input
                v-model.number="draftPinnedBpm"
                type="number"
                min="20"
                max="300"
                step="0.01"
                :disabled="tempoFollowsProject"
                class="w-20 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-xs text-zinc-100 focus:border-sky-500 focus:outline-none disabled:opacity-50"
              >
              <span class="text-[10px] text-zinc-500">BPM</span>
            </label>
            <div
              v-if="!sourceBpm"
              class="mt-1 text-[10px] text-amber-400"
            >
              Source BPM not detected yet — pinning unavailable until analysis completes.
            </div>
          </fieldset>

          <!-- Pitch shift -->
          <fieldset
            v-if="panel === 'pitch'"
            class="flex flex-col gap-2"
          >
            <legend class="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500">
              <span>Pitch shift</span>
              <button
                type="button"
                data-borderless-button="true"
                class="text-[10px] normal-case tracking-normal text-zinc-500 hover:text-zinc-200"
                title="Reset pitch to zero"
                @click="resetPitch"
              >
                reset
              </button>
            </legend>
            <label class="flex items-center gap-2">
              <span class="w-16 text-zinc-400">Semitones</span>
              <input
                v-model.number="draftSemitones"
                type="range"
                min="-12"
                max="12"
                step="1"
                class="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700"
              >
              <span class="w-10 text-right font-mono text-[11px] tabular-nums text-zinc-200">
                {{ draftSemitones > 0 ? '+' : '' }}{{ draftSemitones }}
              </span>
            </label>
            <label class="flex items-center gap-2">
              <span class="w-16 text-zinc-400">Cents</span>
              <input
                v-model.number="draftCents"
                type="range"
                min="-100"
                max="100"
                step="1"
                class="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-zinc-700"
              >
              <span class="w-10 text-right font-mono text-[11px] tabular-nums text-zinc-200">
                {{ draftCents > 0 ? '+' : '' }}{{ draftCents }}
              </span>
            </label>
          </fieldset>
        </div>

        <!-- Footer -->
        <div class="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button
            type="button"
            class="rounded bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
            @click="cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-500"
            @click="save"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Range thumb styled to match the rest of the chrome (cribbed from
   TrackHeaderPanel's track-volume slider). */
input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
  margin-top: -5px;
}
input[type='range']::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}
input[type='range']::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}
input[type='range']::-moz-range-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}
</style>
