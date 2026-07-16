<script setup lang="ts">
import type { ScratchCrossfaderCutKeyDto, ScratchRealismLevelDto } from '@shared/types'

const scratchRealismLevel = defineModel<ScratchRealismLevelDto>('scratchRealismLevel', {
  required: true
})
const scratchCrossfaderCutKey = defineModel<ScratchCrossfaderCutKeyDto>('scratchCrossfaderCutKey', {
  required: true
})
</script>

<template>
  <div class="border-t border-zinc-800 pt-4">
    <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
      Scratch realism
    </h2>
    <p class="mb-3 text-zinc-500">
      Adds held-platter softening and low-level groove texture in the Scratch Editor,
      whether you use the on-screen deck or a controller.
    </p>
    <div class="space-y-2">
      <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
        <input
          v-model="scratchRealismLevel"
          type="radio"
          name="scratch-realism-level"
          value="off"
          class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
        >
        <span class="min-w-0 flex-1 truncate leading-tight">
          <span class="font-medium text-zinc-200">Off</span>
          <span class="text-zinc-500"> — Direct digital response</span>
        </span>
      </label>
      <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
        <input
          v-model="scratchRealismLevel"
          type="radio"
          name="scratch-realism-level"
          value="medium"
          class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
        >
        <span class="min-w-0 flex-1 truncate leading-tight">
          <span class="font-medium text-zinc-200">Medium</span>
          <span class="text-zinc-500"> — Subtle held-platter character</span>
        </span>
      </label>
      <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
        <input
          v-model="scratchRealismLevel"
          type="radio"
          name="scratch-realism-level"
          value="high"
          class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
        >
        <span class="min-w-0 flex-1 truncate leading-tight">
          <span class="font-medium text-zinc-200">High</span>
          <span class="text-zinc-500"> — Stronger vinyl character</span>
        </span>
      </label>
    </div>
  </div>

  <div class="border-t border-zinc-800 pt-4">
    <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
      Scratch crossfader cut
    </h2>
    <p class="mb-3 text-zinc-500">
      In the Scratch Editor a single key acts as the crossfader cut. Holding it
      silences the deck (fader closed); releasing it opens the fader again. Pick
      the key that suits your scratching hand.
    </p>
    <div class="space-y-2">
      <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
        <input
          v-model="scratchCrossfaderCutKey"
          type="radio"
          name="scratch-crossfader-cut-key"
          value="KeyZ"
          class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
        >
        <span class="min-w-0 flex-1 truncate leading-tight">
          <span class="font-medium text-zinc-200">Z</span>
          <span class="text-zinc-500"> — For right-handed scratching</span>
        </span>
      </label>
      <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
        <input
          v-model="scratchCrossfaderCutKey"
          type="radio"
          name="scratch-crossfader-cut-key"
          value="KeyM"
          class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
        >
        <span class="min-w-0 flex-1 truncate leading-tight">
          <span class="font-medium text-zinc-200">M</span>
          <span class="text-zinc-500"> — For left-handed scratching</span>
        </span>
      </label>
    </div>
  </div>
</template>
