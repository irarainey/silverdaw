<script setup lang="ts">
// Application status bar. Lives at the bottom edge of the window and
// surfaces low-priority ambient state — currently just the timeline zoom.
// The backend (audio engine) connection is intentionally NOT shown here:
// the front/back split is an implementation detail the user shouldn't have
// to reason about. Engine availability is handled invisibly by automatic
// recovery, and only surfaces as a friendly overlay when action is needed.

import { computed, nextTick, ref } from 'vue'
import { useUiStore } from '@/stores/uiStore'
import {
  DEFAULT_PX_PER_SECOND,
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND
} from '@/lib/timeline/constants'

const ui = useUiStore()

// Timeline zoom expressed as a percentage of the default (100 px/s = 100%).
// Shown to the nearest whole percent; tooltip carries the raw px/sec.
const zoomPercent = computed(() => Math.round((ui.zoomPxPerSecond / DEFAULT_PX_PER_SECOND) * 100))
const zoomTooltip = computed(() => `Timeline zoom — ${ui.zoomPxPerSecond.toFixed(1)} px/s (100% = ${DEFAULT_PX_PER_SECOND} px/s)`)

// Disable the step buttons at the geometry-clamped extremes so they don't look
// active when they can't move further.
const canZoomOut = computed(() => ui.zoomPxPerSecond > MIN_PX_PER_SECOND)
const canZoomIn = computed(() => ui.zoomPxPerSecond < MAX_PX_PER_SECOND)

function zoomOut(): void {
  ui.requestTimelineZoom('out')
}

function zoomIn(): void {
  ui.requestTimelineZoom('in')
}

// Inline edit of the zoom percentage. Double-clicking the readout swaps it for
// a text field; committing converts the percent back to px/sec and routes it
// through the same clamped zoom request the buttons use.
const editing = ref(false)
const draftPercent = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

async function beginEdit(): Promise<void> {
  draftPercent.value = String(zoomPercent.value)
  editing.value = true
  await nextTick()
  inputEl.value?.focus()
  inputEl.value?.select()
}

function commitEdit(): void {
  if (!editing.value) return
  editing.value = false
  const parsed = Number.parseFloat(draftPercent.value)
  if (!Number.isFinite(parsed) || parsed <= 0) return
  const requested = (parsed / 100) * DEFAULT_PX_PER_SECOND
  const clamped = Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, requested))
  ui.requestTimelineZoomTo(clamped)
}

function cancelEdit(): void {
  editing.value = false
}
</script>

<template>
  <footer
    class="flex h-6 w-full select-none items-center justify-between border-t border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-400"
  >
    <div class="flex items-center gap-2">
      <!-- Timeline zoom: magnifying-glass icon, then −/percent/+ controls. -->
      <span
        class="flex items-center gap-1"
        :title="zoomTooltip"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="mr-0.5 h-3.5 w-3.5"
          aria-hidden="true"
        >
          <circle
            cx="11"
            cy="11"
            r="7"
          />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <button
          type="button"
          data-borderless-button="true"
          class="flex h-4 w-4 items-center justify-center text-zinc-400 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          title="Zoom out"
          :disabled="!canZoomOut"
          @click="zoomOut"
        >
          <span class="text-sm leading-none">−</span>
        </button>
        <input
          v-if="editing"
          ref="inputEl"
          v-model="draftPercent"
          type="text"
          inputmode="numeric"
          class="w-9 rounded border border-zinc-700 bg-zinc-950 px-1 py-px text-right font-mono text-xs tabular-nums text-zinc-100 outline-none focus:border-sky-500"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc.prevent="cancelEdit"
          @blur="commitEdit"
        >
        <span
          v-else
          class="cursor-text font-mono tabular-nums text-zinc-300 hover:text-zinc-100"
          title="Double-click to set the zoom level"
          @dblclick="beginEdit"
        >{{ zoomPercent }}%</span>
        <button
          type="button"
          data-borderless-button="true"
          class="flex h-4 w-4 items-center justify-center text-zinc-400 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          title="Zoom in"
          :disabled="!canZoomIn"
          @click="zoomIn"
        >
          <span class="text-sm leading-none">+</span>
        </button>
      </span>
    </div>

    <div />
  </footer>
</template>
