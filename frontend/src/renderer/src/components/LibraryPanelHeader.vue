<script setup lang="ts">
type LibraryPanelTab = 'library' | 'trackfx' | 'projectfx'

const props = defineProps<{
  collapsed: boolean
  itemCount: number
}>()

const emit = defineEmits<{
  (e: 'toggleCollapsed'): void
  (e: 'import'): void
}>()

const activeTab = defineModel<LibraryPanelTab>('activeTab', { required: true })
</script>

<template>
  <header
    class="flex h-8 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 text-xs uppercase tracking-wide text-zinc-400"
  >
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="mr-1 flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
        :title="props.collapsed ? 'Expand panel' : 'Minimise panel'"
        :aria-label="props.collapsed ? 'Expand panel' : 'Minimise panel'"
        :aria-expanded="!props.collapsed"
        @click="emit('toggleCollapsed')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="h-3.5 w-3.5 transition-transform"
          :class="props.collapsed ? 'rotate-180' : ''"
          aria-hidden="true"
        >
          <path d="M7 10l5 5 5-5H7z" />
        </svg>
      </button>
      <button
        type="button"
        class="rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors"
        :class="activeTab === 'library' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
        :aria-pressed="activeTab === 'library'"
        @click="activeTab = 'library'"
      >
        Library
      </button>
      <button
        type="button"
        class="rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors"
        :class="activeTab === 'trackfx' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
        :aria-pressed="activeTab === 'trackfx'"
        @click="activeTab = 'trackfx'"
      >
        Track FX
      </button>
      <button
        type="button"
        class="rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition-colors"
        :class="activeTab === 'projectfx' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'"
        :aria-pressed="activeTab === 'projectfx'"
        @click="activeTab = 'projectfx'"
      >
        Project FX
      </button>
      <span
        v-if="activeTab === 'library'"
        class="ml-1 text-zinc-500"
      >{{ props.itemCount }} {{ props.itemCount === 1 ? 'item' : 'items' }}</span>
    </div>
    <button
      v-if="activeTab === 'library'"
      type="button"
      class="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"
      title="Import audio files into the library"
      @click="emit('import')"
    >
      Import
    </button>
  </header>
</template>
