<script setup lang="ts">
// Track FX surface, shown in the bottom panel beside the Library. Edits the
// SELECTED track (GarageBand-style: click a track header to select it). For
// now it hosts the per-track Tone EQ — three fixed-band shelving/peak gains
// (Bass / Mid / Treble) plus a Low Cut toggle — wrapped in the same
// plugin-style rack-module chrome used by the Clip Editor.
//
// Editing is live: slider drags push `setTrackTone` through the bridge on
// every `input` (coalesced into one undo step via a per-drag `gestureId`)
// and commit the final value with `gestureEnd` on `change`. Discrete edits
// (Low Cut, reset-to-0) push a single non-coalesced update.

import { computed, onBeforeUnmount, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import ClipEffectModule from '@/components/ClipEffectModule.vue'

const project = useProjectStore()

const selectedTrack = computed(() =>
  project.selectedTrackId
    ? project.tracks.find((t) => t.id === project.selectedTrackId) ?? null
    : null
)

// Tone EQ bands. `key` is the `setTrackTone` patch field; `prop` is the
// (default-suppressed) store property holding the persisted dB value.
const TONE_BANDS = [
  { key: 'bassDb', prop: 'toneBassDb', label: 'Bass' },
  { key: 'midDb', prop: 'toneMidDb', label: 'Mid' },
  { key: 'trebleDb', prop: 'toneTrebleDb', label: 'Treble' }
] as const

type ToneBand = (typeof TONE_BANDS)[number]

function bandValue(band: ToneBand): number {
  const track = selectedTrack.value
  if (!track) return 0
  const v = track[band.prop]
  return typeof v === 'number' ? v : 0
}

const lowCutOn = computed(() => selectedTrack.value?.toneLowCut === true)
const highCutOn = computed(() => selectedTrack.value?.toneHighCut === true)

// Per-drag gesture id so an entire slider drag collapses into a single undo
// step. Scoped to a single band: minting a fresh id whenever the active band
// changes (or after a gesture ends) prevents one band's drag from being
// coalesced into another's. Cleared on every exit path, on selection change,
// and on unmount so a drag interrupted mid-stream (tab switch, track delete)
// can never leak a stale id into the next gesture.
let activeGesture: { band: string; id: string } | null = null

function freshGestureId(): string {
  const c = globalThis.crypto as Crypto | undefined
  return c?.randomUUID ? `tone-${c.randomUUID()}` : `tone-${Date.now()}-${Math.random()}`
}

function ensureGesture(bandKey: string): string {
  if (!activeGesture || activeGesture.band !== bandKey) {
    activeGesture = { band: bandKey, id: freshGestureId() }
  }
  return activeGesture.id
}

function endGesture(): void {
  activeGesture = null
}

function onBandInput(band: ToneBand, raw: string): void {
  const track = selectedTrack.value
  if (!track) return
  const value = Number(raw)
  if (!Number.isFinite(value)) return
  project.setTrackTone(
    track.id,
    { [band.key]: value },
    { gestureId: ensureGesture(band.key), gestureEnd: false }
  )
}

function onBandChange(band: ToneBand, raw: string): void {
  try {
    const track = selectedTrack.value
    if (!track) return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    project.setTrackTone(
      track.id,
      { [band.key]: value },
      { gestureId: ensureGesture(band.key), gestureEnd: true }
    )
  } finally {
    endGesture()
  }
}

// Double-click a slider to snap it back to unity (0 dB).
function onBandReset(band: ToneBand): void {
  try {
    const track = selectedTrack.value
    if (!track) return
    project.setTrackTone(track.id, { [band.key]: 0 }, { gestureEnd: true })
  } finally {
    endGesture()
  }
}

function onToggleLowCut(): void {
  const track = selectedTrack.value
  if (!track) return
  project.setTrackTone(track.id, { lowCut: !lowCutOn.value }, { gestureEnd: true })
}

function onToggleHighCut(): void {
  const track = selectedTrack.value
  if (!track) return
  project.setTrackTone(track.id, { highCut: !highCutOn.value }, { gestureEnd: true })
}

// If the selection changes (incl. the selected track being deleted) mid-drag,
// abandon any open gesture so the next interaction starts a clean undo step.
watch(() => project.selectedTrackId, endGesture)
onBeforeUnmount(endGesture)
</script>

<template>
  <div class="flex h-full min-h-0 w-full flex-col">
    <!-- Empty state: nothing selected. -->
    <div
      v-if="!selectedTrack"
      class="flex h-full w-full items-center justify-center px-4 text-center text-xs text-zinc-500"
    >
      Select a track to edit its effects.
    </div>

    <!-- Rack: one fixed-size module per effect, scrolls horizontally as more
         effects are added (mirrors the Clip Editor's effects rack). -->
    <div
      v-else
      class="track-fx-rack silverdaw-scroll grid min-h-0 min-w-0 flex-1 gap-3 overflow-auto p-3"
      role="group"
      aria-label="Track effects"
    >
      <ClipEffectModule
        title="Tone"
        :cols="1"
        :rows="1"
      >
        <div class="flex w-full flex-col gap-3 text-xs">
          <label
            v-for="band in TONE_BANDS"
            :key="band.key"
            class="flex flex-col gap-1"
          >
            <span class="flex items-center justify-between">
              <span class="text-[10px] uppercase tracking-wider text-zinc-500">
                {{ band.label }}
              </span>
              <span class="font-mono text-[10px] text-zinc-400">
                {{ bandValue(band) > 0 ? '+' : '' }}{{ bandValue(band).toFixed(1) }} dB
              </span>
            </span>
            <input
              class="tone-range-input w-full"
              type="range"
              min="-15"
              max="15"
              step="0.5"
              :value="bandValue(band)"
              :aria-label="band.label + ' gain in decibels'"
              :title="'Double-click to reset to 0 dB'"
              @input="onBandInput(band, ($event.target as HTMLInputElement).value)"
              @change="onBandChange(band, ($event.target as HTMLInputElement).value)"
              @dblclick="onBandReset(band)"
            >
          </label>

          <button
            type="button"
            class="flex items-center justify-between rounded border px-2 py-1.5 text-[11px] transition-colors"
            :class="
              lowCutOn
                ? 'border-sky-500 bg-sky-500/15 text-sky-200'
                : 'border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
            "
            :aria-pressed="lowCutOn"
            @click="onToggleLowCut"
          >
            <span class="uppercase tracking-wider">Low Cut</span>
            <span class="font-mono text-[10px]">{{ lowCutOn ? 'ON' : 'OFF' }}</span>
          </button>

          <button
            type="button"
            class="flex items-center justify-between rounded border px-2 py-1.5 text-[11px] transition-colors"
            :class="
              highCutOn
                ? 'border-sky-500 bg-sky-500/15 text-sky-200'
                : 'border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
            "
            :aria-pressed="highCutOn"
            @click="onToggleHighCut"
          >
            <span class="uppercase tracking-wider">High Cut</span>
            <span class="font-mono text-[10px]">{{ highCutOn ? 'ON' : 'OFF' }}</span>
          </button>
        </div>
      </ClipEffectModule>
    </div>
  </div>
</template>

<style scoped>
/* Modular grid — fixed-size base cells so each module keeps a consistent
   aspect ratio however the panel is sized; horizontal scroll reveals
   further effects as they are added. */
.track-fx-rack {
  --cell-w: 17rem; /* 272px */
  --cell-h: 16rem; /* 256px — sized so the Tone EQ (3 bands + Low/High Cut) fits without an inner scrollbar */
  grid-template-rows: repeat(1, var(--cell-h));
  grid-auto-columns: var(--cell-w);
  grid-auto-flow: column dense;
  justify-content: start;
  align-content: start;
}

.tone-range-input {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 9999px;
  background: #3f3f46;
  cursor: pointer;
  outline: none;
}

.tone-range-input:focus,
.tone-range-input:focus-visible {
  outline: none;
  box-shadow: none;
}

.tone-range-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

.tone-range-input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

/* Firefox draws a dotted focus ring around the thumb; suppress it. */
.tone-range-input::-moz-focus-outer {
  border: 0;
}
</style>
