<script setup lang="ts">
// Application status bar. Lives at the bottom edge of the window and
// surfaces low-priority ambient state — currently the backend (JUCE
// bridge) connection status, the current timeline zoom, plus a
// transient progress bar while files are being imported into the
// library.

import { computed } from 'vue'
import { useTransportStore } from '@/stores/transportStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useUiStore } from '@/stores/uiStore'
import { DEFAULT_PX_PER_SECOND } from '@/lib/timeline/constants'

const transport = useTransportStore()
const library = useLibraryStore()
const ui = useUiStore()

// Percentage 0–100 for the import-progress bar width. Pre-computed so the
// template doesn't have to do arithmetic on a watched getter.
const importPercent = computed(() => Math.round(library.importFraction * 100))

// Timeline zoom expressed as a percentage of the default (100 px/s = 100%).
// Range: 10/60 ≈ 17% out to 480/60 = 800%. Shown to the nearest whole
// percent; tooltip carries the raw px/sec for power users.
const zoomPercent = computed(() => Math.round((ui.zoomPxPerSecond / DEFAULT_PX_PER_SECOND) * 100))
const zoomTooltip = computed(() => `Timeline zoom — ${ui.zoomPxPerSecond.toFixed(1)} px/s (100% = ${DEFAULT_PX_PER_SECOND} px/s)`)
</script>

<template>
  <footer
    class="flex h-6 w-full select-none items-center justify-between border-t border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-400"
  >
    <div class="flex items-center gap-2">
      <!-- Backend bridge status: plug icon + dot. Icon labels the
           meaning (network/backend connection); the dot is the at-a-
           glance state colour. -->
      <span
        class="flex items-center gap-1.5"
        :title="transport.connected ? 'Backend connected' : 'Backend disconnected'"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <!-- Plug-and-socket glyph. -->
          <path d="M9 7V3" />
          <path d="M15 7V3" />
          <rect
            x="7"
            y="7"
            width="10"
            height="6"
            rx="1"
          />
          <path d="M12 13v3a3 3 0 0 0 3 3h2" />
        </svg>
        <span
          class="inline-block h-2 w-2 rounded-full"
          :class="transport.connected ? 'bg-emerald-500' : 'bg-zinc-600'"
        />
      </span>

      <span
        class="h-3 w-px bg-zinc-700"
        aria-hidden="true"
      />

      <!-- Timeline zoom: magnifying-glass icon + percent value. -->
      <span
        class="flex items-center gap-1.5"
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
          class="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <circle
            cx="11"
            cy="11"
            r="7"
          />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <span class="font-mono tabular-nums text-zinc-300">{{ zoomPercent }}%</span>
      </span>
    </div>

    <!-- Library import progress. Only mounted while a batch is in
             flight; the track fills as files finish decoding. The label
             gives a precise "done / total" so the bar reads correctly even
             when the values jump (e.g. one big slow file followed by
             several already-cached ones). -->
    <div
      v-if="library.isImporting"
      class="flex items-center gap-2 text-[11px] text-zinc-400"
      role="progressbar"
      :aria-valuenow="library.importDone"
      :aria-valuemin="0"
      :aria-valuemax="library.importTotal"
      :title="'Importing ' + library.importDone + ' / ' + library.importTotal"
    >
      <span class="font-mono tabular-nums">Importing {{ library.importDone }} / {{ library.importTotal }}</span>
      <div class="h-1.5 w-40 overflow-hidden rounded-full bg-zinc-800">
        <div
          class="h-full bg-blue-500 transition-[width] duration-150 ease-out"
          :style="{ width: importPercent + '%' }"
        />
      </div>
    </div>
    <div v-else />
  </footer>
</template>
