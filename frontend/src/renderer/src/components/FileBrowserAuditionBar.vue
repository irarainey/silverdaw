<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useFileBrowserStore, fileBrowserRowIndentPx } from '@/stores/fileBrowserStore'
import FileBrowserFileRow from '@/components/FileBrowserFileRow.vue'

defineEmits<{
  (e: 'contextMenu', payload: { event: MouseEvent; path: string }): void
}>()

const browser = useFileBrowserStore()
const { pinnedAudition } = storeToRefs(browser)
</script>

<template>
  <!-- Lives outside the tree's scroller so a file that is playing is never lost to
       scrolling or a filter. The strip is always rendered so the tree below it cannot
       jump as an audition starts and stops; it only carries a row while one plays. A
       stopped audition is reachable in its folder like any other file — it stays listed
       there throughout. -->
  <div
    class="shrink-0 border-b border-zinc-800 bg-zinc-900/60 py-0.5"
    :aria-hidden="pinnedAudition ? undefined : 'true'"
  >
    <FileBrowserFileRow
      v-if="pinnedAudition"
      :row="pinnedAudition"
      @context-menu="$emit('contextMenu', $event)"
    />
    <!-- Idle, the strip keeps a row's shape rather than reading as dead space: the same
         controls in their disabled state, and a label saying why. -->
    <div
      v-else
      class="flex h-8 select-none items-center gap-2 pr-2 text-xs text-zinc-600"
      :style="{ paddingLeft: fileBrowserRowIndentPx(0) + 'px' }"
    >
      <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-zinc-800/60">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-3 w-3 text-zinc-600"
          aria-hidden="true"
        >
          <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
        </svg>
      </div>
      <span class="min-w-0 flex-1 truncate">Nothing playing</span>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled
          class="flex h-5 w-5 cursor-not-allowed items-center justify-center rounded text-zinc-400 opacity-40"
          title="Back to start"
          aria-label="Back to start"
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            class="h-3 w-3"
            aria-hidden="true"
          >
            <path d="M6 6h2.5v12H6zm4 6l9 6V6z" />
          </svg>
        </button>
        <button
          type="button"
          disabled
          class="flex h-5 w-5 cursor-not-allowed items-center justify-center rounded text-zinc-400 opacity-40"
          title="Play"
          aria-label="Play"
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            class="h-3 w-3"
            aria-hidden="true"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
        <button
          type="button"
          disabled
          class="cursor-not-allowed rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300 opacity-40"
          title="Import into the library"
        >
          Import
        </button>
      </div>
    </div>
  </div>
</template>
