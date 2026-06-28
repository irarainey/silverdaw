<script setup lang="ts">
const lengthInput = defineModel<string>('lengthInput', { required: true })
const bpmInput = defineModel<string>('bpmInput', { required: true })
const isEditingLength = defineModel<boolean>('isEditingLength', { required: true })
const isEditingBpm = defineModel<boolean>('isEditingBpm', { required: true })

defineProps<{
  positionDisplay: string
  barPosition: string
  timingEditable: boolean
  lengthEditable: boolean
  projectBpmPending: boolean
  effectiveSampleRateLabel: string
  metronomeEnabled: boolean
}>()

const emit = defineEmits<{
  lengthCommit: []
  lengthKeydown: [event: KeyboardEvent]
  bumpLength: [deltaSeconds: number]
  bpmCommit: []
  bpmKeydown: [event: KeyboardEvent]
  bumpBpm: [delta: number]
  toggleMetronome: []
}>()
</script>

<template>
  <div class="flex flex-1 justify-end">
    <div
      class="flex items-center gap-3 rounded border border-zinc-700 bg-zinc-950/40 py-1 pl-3 pr-2"
      title="Timing"
    >
      <div class="flex flex-col items-start leading-none">
        <span class="text-[9px] uppercase tracking-wide text-zinc-500">Pos</span>
        <span
          :class="[
            'font-mono text-base tabular-nums',
            timingEditable ? 'text-zinc-100' : 'text-zinc-500'
          ]"
        >{{ positionDisplay }}</span>
      </div>
      <div class="h-7 w-px bg-zinc-800" />
      <div class="flex flex-col items-start leading-none">
        <span class="text-[9px] uppercase tracking-wide text-zinc-500">Bar</span>
        <span
          :class="[
            'font-mono text-base tabular-nums',
            timingEditable ? 'text-zinc-100' : 'text-zinc-500'
          ]"
          title="Bar.Beat.Sub"
        >{{
          barPosition
        }}</span>
      </div>
      <div class="h-7 w-px bg-zinc-800" />
      <div class="-mr-1 flex flex-col items-start leading-none">
        <span class="text-[9px] uppercase tracking-wide text-zinc-500">Length</span>
        <div class="flex items-center">
          <input
            v-model="lengthInput"
            type="text"
            inputmode="numeric"
            spellcheck="false"
            :disabled="!lengthEditable"
            :title="lengthEditable ? 'Project length (mm:ss or h:mm:ss). Use ↑/↓ or the spinner to adjust by 1s; hold Shift for 10s.' : 'Add a track to edit project length'"
            class="w-[5ch] bg-transparent font-mono text-base tabular-nums text-zinc-100 outline-none focus:text-blue-300 disabled:cursor-not-allowed disabled:text-zinc-500"
            @focus="isEditingLength = true"
            @blur="emit('lengthCommit')"
            @keydown="emit('lengthKeydown', $event)"
          >
          <div class="ml-1 flex flex-col text-zinc-500">
            <button
              type="button"
              data-borderless-button="true"
              tabindex="-1"
              :disabled="!lengthEditable"
              title="Increase length (Shift: +10s)"
              class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              @mousedown.prevent
              @click="(e) => emit('bumpLength', e.shiftKey ? 10 : 1)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-3 w-3"
              >
                <path d="M7 14l5-5 5 5H7z" />
              </svg>
            </button>
            <button
              type="button"
              data-borderless-button="true"
              tabindex="-1"
              :disabled="!lengthEditable"
              title="Decrease length (Shift: -10s)"
              class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              @mousedown.prevent
              @click="(e) => emit('bumpLength', e.shiftKey ? -10 : -1)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-3 w-3"
              >
                <path d="M7 10l5 5 5-5H7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div class="h-7 w-px bg-zinc-800" />
      <div class="flex flex-col items-start leading-none">
        <span class="text-[9px] uppercase tracking-wide text-zinc-500">BPM</span>
        <div class="flex items-center">
          <input
            v-model="bpmInput"
            type="number"
            min="20"
            max="300"
            step="0.01"
            spellcheck="false"
            :disabled="!timingEditable"
            :title="projectBpmPending ? 'Detecting tempo for the first clip…' : timingEditable ? 'Tempo (20 – 300 BPM). Use ↑/↓ or the spinner to adjust by 1; hold Shift for 10.' : 'Add a track to edit project tempo'"
            :class="[
              'w-[6ch] rounded bg-transparent font-mono text-base tabular-nums outline-none focus:text-blue-300 disabled:cursor-not-allowed disabled:text-zinc-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
              projectBpmPending
                ? 'animate-pulse bg-blue-500/10 px-1 text-blue-200 ring-1 ring-blue-400/40'
                : 'text-zinc-100'
            ]"
            @focus="isEditingBpm = true"
            @blur="emit('bpmCommit')"
            @keydown="emit('bpmKeydown', $event)"
          >
          <div class="ml-1 flex flex-col text-zinc-500">
            <button
              type="button"
              data-borderless-button="true"
              tabindex="-1"
              :disabled="!timingEditable"
              title="Increase BPM (Shift: +10)"
              class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              @mousedown.prevent
              @click="(e) => emit('bumpBpm', e.shiftKey ? 10 : 1)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-3 w-3"
              >
                <path d="M7 14l5-5 5 5H7z" />
              </svg>
            </button>
            <button
              type="button"
              data-borderless-button="true"
              tabindex="-1"
              :disabled="!timingEditable"
              title="Decrease BPM (Shift: -10)"
              class="flex h-3 w-3 items-center justify-center leading-none hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              @mousedown.prevent
              @click="(e) => emit('bumpBpm', e.shiftKey ? -10 : -1)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-3 w-3"
              >
                <path d="M7 10l5 5 5-5H7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div class="h-7 w-px bg-zinc-800" />
      <div
        class="flex flex-col items-start leading-none"
        :title="`Project sample rate: ${effectiveSampleRateLabel}. Edit in File ▸ Project Properties…`"
      >
        <span class="text-[9px] uppercase tracking-wide text-zinc-500">RATE</span>
        <span class="font-mono text-base tabular-nums text-zinc-100">{{ effectiveSampleRateLabel }}</span>
      </div>
      <div class="h-7 w-px bg-zinc-800" />
      <button
        type="button"
        role="switch"
        :aria-checked="metronomeEnabled"
        aria-label="Metronome click"
        :title="metronomeEnabled ? 'Metronome on — click plays in time with the project tempo. Click to turn off.' : 'Metronome off — click plays an audible tick in time with the project tempo. Click to turn on.'"
        class="flex h-7 w-7 items-center justify-center rounded border transition-colors"
        :class="metronomeEnabled
          ? 'border-sky-500 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25'
          : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300'
        "
        @click="emit('toggleMetronome')"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M8 3h8l3 18H5L8 3z" />
          <path d="M9 9l7-4" />
          <path d="M7 16h10" />
        </svg>
      </button>
    </div>
  </div>
</template>
