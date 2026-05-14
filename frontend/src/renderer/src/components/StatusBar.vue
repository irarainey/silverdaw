<script setup lang="ts">
// Application status bar. Lives at the bottom edge of the window and
// surfaces low-priority ambient state — currently the backend (JUCE
// bridge) connection status, plus a transient progress bar while files
// are being imported into the library.

import { computed } from 'vue'
import { useTransportStore } from '@/stores/transportStore'
import { useLibraryStore } from '@/stores/libraryStore'

const transport = useTransportStore()
const library = useLibraryStore()

// Percentage 0–100 for the import-progress bar width. Pre-computed so the
// template doesn't have to do arithmetic on a watched getter.
const importPercent = computed(() => Math.round(library.importFraction * 100))
</script>

<template>
    <footer
        class="flex h-6 w-full select-none items-center justify-between border-t border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-400">
        <div class="flex items-center gap-2">
            <span class="inline-block h-2 w-2 rounded-full"
                :class="transport.connected ? 'bg-emerald-500' : 'bg-zinc-600'"
                :title="transport.connected ? 'Backend connected' : 'Backend disconnected'" />
        </div>

        <!-- Library import progress. Only mounted while a batch is in
             flight; the track fills as files finish decoding. The label
             gives a precise "done / total" so the bar reads correctly even
             when the values jump (e.g. one big slow file followed by
             several already-cached ones). -->
        <div v-if="library.isImporting" class="flex items-center gap-2 text-[11px] text-zinc-400" role="progressbar"
            :aria-valuenow="library.importDone" :aria-valuemin="0" :aria-valuemax="library.importTotal"
            :title="'Importing ' + library.importDone + ' / ' + library.importTotal">
            <span class="font-mono tabular-nums">Importing {{ library.importDone }} / {{ library.importTotal }}</span>
            <div class="h-1.5 w-40 overflow-hidden rounded-full bg-zinc-800">
                <div class="h-full bg-blue-500 transition-[width] duration-150 ease-out"
                    :style="{ width: importPercent + '%' }" />
            </div>
        </div>
        <div v-else />
    </footer>
</template>
