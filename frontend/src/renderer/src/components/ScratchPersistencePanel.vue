<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ScratchPatternPersistence } from '@/lib/scratch/scratchPatternPersistence'

const props = defineProps<{
  persistence: ScratchPatternPersistence
  canSave: boolean
  canUpdate: boolean
}>()

const emit = defineEmits<{
  (event: 'confirmDelete', patternId: string): void
}>()

const renamingPatternId = ref<string | null>(null)
const renameValue = ref('')

const patternNameModel = computed({
  get: () => props.persistence.patternName.value,
  // eslint-disable-next-line vue/no-mutating-props -- writable ref in service interface
  set: (v: string) => { props.persistence.patternName.value = v }
})

function startRename(patternId: string, currentName: string): void {
  renamingPatternId.value = patternId
  renameValue.value = currentName
}

function commitRename(): void {
  if (renamingPatternId.value && renameValue.value.trim()) {
    props.persistence.rename(renamingPatternId.value, renameValue.value)
  }
  renamingPatternId.value = null
  renameValue.value = ''
}

function cancelRename(): void {
  renamingPatternId.value = null
  renameValue.value = ''
}
</script>

<template>
  <div class="flex shrink-0 flex-col gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
    <div class="flex items-center gap-2">
      <input
        v-model="patternNameModel"
        type="text"
        placeholder="Pattern name"
        class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-200 outline-none focus:border-zinc-500"
        aria-label="Pattern name"
      >
      <button
        type="button"
        class="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-40"
        :disabled="!canSave"
        @click="persistence.savePattern()"
      >
        Save Pattern
      </button>
      <button
        v-if="canUpdate"
        type="button"
        class="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-700"
        @click="persistence.updatePattern()"
      >
        Update Pattern
      </button>
    </div>

    <div
      v-if="persistence.savedPatterns.value.length > 0"
      class="flex max-h-24 flex-col gap-0.5 overflow-y-auto"
    >
      <div
        v-for="saved in persistence.savedPatterns.value"
        :key="saved.id"
        class="group flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs transition-colors"
        :class="persistence.selectedSavedId.value === saved.id
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'"
      >
        <template v-if="renamingPatternId === saved.id">
          <input
            v-model="renameValue"
            type="text"
            class="min-w-0 flex-1 rounded border border-zinc-600 bg-zinc-900 px-1 py-0 text-xs text-zinc-200 outline-none focus:border-zinc-400"
            aria-label="Rename pattern"
            @keydown.enter="commitRename"
            @keydown.escape.stop="cancelRename"
            @blur="commitRename"
          >
        </template>
        <template v-else>
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left"
            :title="saved.name"
            @click="persistence.selectAndLoad(saved.id)"
          >
            {{ saved.name }}
          </button>
        </template>
        <button
          v-if="renamingPatternId !== saved.id"
          type="button"
          class="shrink-0 text-[10px] text-zinc-500 opacity-0 transition-opacity hover:text-zinc-300 group-hover:opacity-100"
          title="Rename"
          @click.stop="startRename(saved.id, saved.name)"
        >
          ✏
        </button>
        <button
          v-if="renamingPatternId !== saved.id"
          type="button"
          class="shrink-0 text-[10px] text-zinc-500 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          title="Delete"
          @click.stop="emit('confirmDelete', saved.id)"
        >
          ✕
        </button>
      </div>
    </div>
  </div>
</template>
