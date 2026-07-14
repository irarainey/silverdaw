<script setup lang="ts">
import type {
  BrakeDurationDto,
  BrakeCurveDto,
  BackspinDurationDto,
  BackspinIntensityDto,
  ScratchCrossfaderCutKeyDto
} from '@shared/types'

const brakeDuration = defineModel<BrakeDurationDto>('brakeDuration', { required: true })
const brakeCurve = defineModel<BrakeCurveDto>('brakeCurve', { required: true })
const backspinDuration = defineModel<BackspinDurationDto>('backspinDuration', { required: true })
const backspinIntensity = defineModel<BackspinIntensityDto>('backspinIntensity', { required: true })
const scratchCrossfaderCutKey = defineModel<ScratchCrossfaderCutKeyDto>('scratchCrossfaderCutKey', {
  required: true
})
</script>

<template>
  <section class="space-y-5">
    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Turntable brake
      </h2>
      <p class="mb-3 text-zinc-500">
        The brake decelerates a clip to a stop at its end, like a vinyl
        record-stop. These set how long it takes and how the slowdown is shaped,
        applied to every clip that uses it.
      </p>

      <p class="mb-2 font-medium text-zinc-300">
        Duration
      </p>
      <div class="space-y-2">
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="brakeDuration"
            type="radio"
            name="brake-duration"
            value="short"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Short</span>
            <span class="text-zinc-500"> — Snappy (~0.4 s)</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="brakeDuration"
            type="radio"
            name="brake-duration"
            value="medium"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Medium</span>
            <span class="text-zinc-500"> — Balanced (~0.6 s)</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="brakeDuration"
            type="radio"
            name="brake-duration"
            value="long"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Long</span>
            <span class="text-zinc-500"> — Drawn-out (~0.9 s)</span>
          </span>
        </label>
      </div>

      <p class="mt-3 mb-2 font-medium text-zinc-300">
        Curve
      </p>
      <div class="space-y-2">
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="brakeCurve"
            type="radio"
            name="brake-curve"
            value="linear"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Linear</span>
            <span class="text-zinc-500"> — Constant slowdown</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="brakeCurve"
            type="radio"
            name="brake-curve"
            value="curved"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Curved</span>
            <span class="text-zinc-500"> — Fast, then eases</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="brakeCurve"
            type="radio"
            name="brake-curve"
            value="steep"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Steep</span>
            <span class="text-zinc-500"> — Very fast, then eases</span>
          </span>
        </label>
      </div>
    </div>

    <div class="border-t border-zinc-800 pt-4">
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Turntable backspin
      </h2>
      <p class="mb-3 text-zinc-500">
        The backspin rewinds a clip backwards at its end, like a DJ pulling the
        vinyl back. These set how long it spins and how hard it is pulled, applied
        to every clip that uses it.
      </p>

      <p class="mb-2 font-medium text-zinc-300">
        Duration
      </p>
      <div class="space-y-2">
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="backspinDuration"
            type="radio"
            name="backspin-duration"
            value="short"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Short</span>
            <span class="text-zinc-500"> — Snappy (~0.4 s)</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="backspinDuration"
            type="radio"
            name="backspin-duration"
            value="medium"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Medium</span>
            <span class="text-zinc-500"> — Balanced (~0.6 s)</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="backspinDuration"
            type="radio"
            name="backspin-duration"
            value="long"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Long</span>
            <span class="text-zinc-500"> — Drawn-out (~0.9 s)</span>
          </span>
        </label>
      </div>

      <p class="mt-3 mb-2 font-medium text-zinc-300">
        Intensity
      </p>
      <div class="space-y-2">
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="backspinIntensity"
            type="radio"
            name="backspin-intensity"
            value="gentle"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Gentle</span>
            <span class="text-zinc-500"> — Soft pull (4×)</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="backspinIntensity"
            type="radio"
            name="backspin-intensity"
            value="medium"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Medium</span>
            <span class="text-zinc-500"> — Firm pull (6×)</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <input
            v-model="backspinIntensity"
            type="radio"
            name="backspin-intensity"
            value="wild"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">Wild</span>
            <span class="text-zinc-500"> — Hard pull (8×)</span>
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
  </section>
</template>
