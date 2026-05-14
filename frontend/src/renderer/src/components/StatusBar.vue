<script setup lang="ts">
// Application status bar. Lives at the bottom edge of the window and
// surfaces low-priority ambient state — currently just the backend
// (JUCE bridge) connection status. The colour-coded dot mirrors the
// one that used to sit on the transport bar.

import { useTransportStore } from '@/stores/transportStore'

const transport = useTransportStore()
</script>

<template>
    <footer
        class="flex h-6 w-full select-none items-center justify-between border-t border-zinc-800 bg-zinc-900 px-3 text-xs text-zinc-400">
        <div class="flex items-center gap-2">
            <span class="inline-block h-2 w-2 rounded-full"
                :class="transport.connected ? 'bg-emerald-500' : 'bg-zinc-600'"
                :title="transport.connected ? 'Backend connected' : 'Backend disconnected'" />
        </div>
        <div />
    </footer>
</template>
