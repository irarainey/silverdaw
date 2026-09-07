<script setup lang="ts">
// Shared Rubber Band mode for the Clip Editor effects rack. One stretcher does
// both the time stretch and the pitch shift, so this setting cannot differ
// between the Warp and Pitch modules — it lives in its own module to make that
// plain rather than looking like it belongs to warp alone.

import type { ClipEditorWarpDraft } from '@/lib/clipEditor/useClipEditorWarpDraft'
import type { ClipWarpMode } from '@shared/bridge-protocol'
import { computed } from 'vue'

const props = defineProps<{
  draft: ClipEditorWarpDraft
}>()

const MODES: { mode: ClipWarpMode; blurb: string }[] = [
  { mode: 'rhythmic', blurb: 'Best for drums, percussion and loops with a strong beat.' },
  { mode: 'tonal', blurb: 'Best for vocals, bass and single instruments held on a note.' },
  { mode: 'complex', blurb: 'Best for full mixes and dense material. Uses more CPU.' }
]

// Alias the draft's refs into local consts so the template never reaches
// through the `draft` prop directly, keeping `vue/no-mutating-props` happy.
const draftMode = props.draft.draftMode
const draftProcessorEnabled = props.draft.draftProcessorEnabled

const activeBlurb = computed(
  () => MODES.find((m) => m.mode === draftMode.value)?.blurb ?? ''
)
</script>

<template>
  <fieldset
    class="flex w-full flex-col gap-3 text-xs"
    :disabled="!draftProcessorEnabled"
    :class="!draftProcessorEnabled ? 'opacity-50' : ''"
  >
    <p class="text-[11px] leading-snug text-zinc-400">
      Applies to both the warp and the pitch shift.
    </p>

    <div class="flex flex-col gap-1">
      <div class="flex gap-1">
        <button
          v-for="m in MODES"
          :key="m.mode"
          type="button"
          class="flex-1 rounded border px-2 py-1 text-xs capitalize transition-colors"
          :class="draftMode === m.mode
            ? 'border-sky-500 bg-sky-600/30 text-zinc-100'
            : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
          "
          @click="draftMode = m.mode"
        >
          {{ m.mode }}
        </button>
      </div>
      <p class="text-[11px] leading-snug text-zinc-500">
        {{ activeBlurb }}
      </p>
    </div>

    <p
      v-if="!draftProcessorEnabled"
      class="text-[11px] leading-snug text-zinc-500"
    >
      Enable warp or set a pitch shift to choose a mode.
    </p>
  </fieldset>
</template>
