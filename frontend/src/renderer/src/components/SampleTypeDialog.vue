<script setup lang="ts">
// Asks whether a clip should be saved as a music sample (inherits the source
// tempo, beats, key, and cover art so it warps on drop — like a loop) or a
// simple sample (a bare one-shot with no musical metadata that never warps —
// for sound effects and vocal snippets). The choice sets the new sample's
// classification on the backend.
import { computed, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'

const props = defineProps<{ open: boolean; clipId: string | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()

const clipName = computed(() => {
  const clip = props.clipId ? project.clips[props.clipId] : null
  return clip?.name?.trim() || clip?.fileName || ''
})

const choice = ref<'music' | 'sample'>('music')

watch(
  () => props.open,
  (open) => {
    if (open) choice.value = 'music'
  }
)

function create(): void {
  if (props.clipId) project.saveClipAsSample(props.clipId, choice.value)
  emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
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
      v-if="open"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sample-type-title"
    >
      <div
        tabindex="-1"
        class="dialog-card w-[min(460px,92vw)]"
        @keydown="onKeydown"
      >
        <div class="dialog-header">
          <h1
            id="sample-type-title"
            class="dialog-title truncate"
          >
            Save as Sample
            <span class="ml-2 truncate text-xs font-normal text-zinc-500">
              {{ clipName }}
            </span>
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-2 text-xs">
          <label
            class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
          >
            <input
              v-model="choice"
              type="radio"
              name="sample-type"
              value="music"
              class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
            >
            <span class="flex-1">
              <span class="block font-medium text-zinc-200">Music sample</span>
              <span class="mt-0.5 block text-zinc-500">
                A loop or musical phrase. Keeps the source tempo, beat markers, key,
                and cover art, and warps to the project tempo when dropped onto a track.
              </span>
            </span>
          </label>
          <label
            class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
          >
            <input
              v-model="choice"
              type="radio"
              name="sample-type"
              value="sample"
              class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
            >
            <span class="flex-1">
              <span class="block font-medium text-zinc-200">Simple sample</span>
              <span class="mt-0.5 block text-zinc-500">
                A one-shot sound effect or vocal snippet. Carries no tempo or beat
                metadata and is never warped when dropped onto a track.
              </span>
            </span>
          </label>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            @click="create"
          >
            Create Sample
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
