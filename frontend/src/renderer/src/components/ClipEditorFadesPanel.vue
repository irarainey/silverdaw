<script setup lang="ts">
// Fades tab inside the Clip Editor's bottom panel area. Pure presentation:
// the draft state + dirty-check live in `useClipEditorFadesDraft`, owned
// by the parent dialog so Save / Cancel can commit / discard atomically
// alongside the other tabs' drafts.

import { computed } from 'vue'
import type { ClipEditorFadesDraft } from '@/lib/clipEditor/useClipEditorFadesDraft'

const props = defineProps<{
  draft: ClipEditorFadesDraft
  /** Audible-window length in timeline ms (i.e. post-warp). Used for the
   *  Max attribute on the inputs so users see immediate feedback when
   *  they try to push a fade past the clip length. Pass 0 / undefined
   *  while the clip metadata is still resolving — the input falls back
   *  to a permissive cap. */
  effectiveDurationMs?: number
}>()

const draftFadeInMs = props.draft.draftFadeInMs
const draftFadeOutMs = props.draft.draftFadeOutMs

const maxFadeMs = computed(() => {
  if (!props.effectiveDurationMs || props.effectiveDurationMs <= 0) return 60_000
  return Math.round(props.effectiveDurationMs)
})

const fadeInModel = computed<number>({
  get: () => Math.round(draftFadeInMs.value),
  set: (v) => {
    draftFadeInMs.value = Math.max(0, Number.isFinite(v) ? v : 0)
    props.draft.markEdited('in')
  }
})

const fadeOutModel = computed<number>({
  get: () => Math.round(draftFadeOutMs.value),
  set: (v) => {
    draftFadeOutMs.value = Math.max(0, Number.isFinite(v) ? v : 0)
    props.draft.markEdited('out')
  }
})
</script>

<template>
  <div class="flex w-full flex-col gap-3 text-xs">
    <div>
      <h3 class="text-sm font-semibold text-zinc-100">
        Fades
      </h3>
      <p class="mt-1 text-[11px] leading-4 text-zinc-500">
        Linear ramp at the head / tail of the clip. Previewed live in the
        editor; saved with the rest of your changes.
      </p>
    </div>

    <fieldset class="grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-900/70 p-3">
      <label class="flex flex-col gap-1">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">
          Fade in
        </span>
        <div class="flex items-center gap-2">
          <input
            v-model.number="fadeInModel"
            type="number"
            min="0"
            :max="maxFadeMs"
            step="10"
            class="w-24 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
          >
          <span class="text-[10px] text-zinc-500">ms</span>
        </div>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">
          Fade out
        </span>
        <div class="flex items-center gap-2">
          <input
            v-model.number="fadeOutModel"
            type="number"
            min="0"
            :max="maxFadeMs"
            step="10"
            class="w-24 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-xs text-zinc-100 focus:border-sky-500 focus:outline-none"
          >
          <span class="text-[10px] text-zinc-500">ms</span>
        </div>
      </label>
    </fieldset>
  </div>
</template>
