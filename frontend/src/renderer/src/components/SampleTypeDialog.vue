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

        <div class="flex flex-col gap-2 px-5 py-4 text-xs">
          <button
            type="button"
            class="flex flex-col gap-1 rounded border px-3 py-2 text-left transition-colors"
            :class="choice === 'music'
              ? 'border-sky-500 bg-sky-500/15'
              : 'border-zinc-700 bg-zinc-800 hover:border-zinc-600'
            "
            @click="choice = 'music'"
          >
            <span class="font-medium text-zinc-100">Music sample</span>
            <span class="text-[11px] leading-4 text-zinc-400">
              A loop or musical phrase. Keeps the source tempo, beat markers, key,
              and cover art, and warps to the project tempo when dropped onto a track.
            </span>
          </button>
          <button
            type="button"
            class="flex flex-col gap-1 rounded border px-3 py-2 text-left transition-colors"
            :class="choice === 'sample'
              ? 'border-sky-500 bg-sky-500/15'
              : 'border-zinc-700 bg-zinc-800 hover:border-zinc-600'
            "
            @click="choice = 'sample'"
          >
            <span class="font-medium text-zinc-100">Simple sample</span>
            <span class="text-[11px] leading-4 text-zinc-400">
              A one-shot sound effect or vocal snippet. Carries no tempo or beat
              metadata and is never warped when dropped onto a track.
            </span>
          </button>
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
