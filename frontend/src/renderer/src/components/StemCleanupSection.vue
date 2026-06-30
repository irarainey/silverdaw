<script setup lang="ts">
import type { StemEnhanceStrength } from '@shared/bridge-protocol'

interface StrengthOption {
  readonly value: StemEnhanceStrength
  readonly label: string
  readonly hint: string
}

defineProps<{
  /** Section heading (e.g. "Vocal cleanup"). */
  title: string
  /** Primary checkbox label. */
  checkboxLabel: string
  /** Explanatory copy shown under the checkbox. */
  description: string
  /** Unique radio-group name so multiple sections don't share selection state. */
  radioName: string
  /** Intensity choices revealed when cleanup is enabled. */
  options: ReadonlyArray<StrengthOption>
}>()

const enabled = defineModel<boolean>('enabled', { required: true })
const strength = defineModel<StemEnhanceStrength>('strength', { required: true })
</script>

<template>
  <div>
    <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
      {{ title }}
    </h2>
    <label class="flex cursor-pointer items-start gap-3">
      <input
        v-model="enabled"
        type="checkbox"
        class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
      >
      <span class="flex-1">
        <span class="block font-medium text-zinc-200">{{ checkboxLabel }}</span>
        <span class="mt-0.5 block text-zinc-500">{{ description }}</span>
      </span>
    </label>

    <div
      v-if="enabled"
      class="mt-3 space-y-2"
    >
      <label
        v-for="option in options"
        :key="option.value"
        class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
      >
        <input
          v-model="strength"
          type="radio"
          :name="radioName"
          :value="option.value"
          class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
        >
        <span class="min-w-0 flex-1 truncate leading-tight">
          <span class="font-medium text-zinc-200">{{ option.label }}</span>
          <span class="text-zinc-500"> — {{ option.hint }}</span>
        </span>
      </label>
    </div>
  </div>
</template>
