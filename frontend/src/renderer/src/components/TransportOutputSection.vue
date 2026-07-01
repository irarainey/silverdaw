<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import { MAX_MASTER_DB, formatLinearAsDb, linearToTaperPosition } from '@/lib/audio/db'
import type { QuickSwitchDevice } from '@/lib/transport/useAudioQuickSwitch'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import MasterMeter from '@/components/MasterMeter.vue'

const audioMenuOpen = defineModel<boolean>('audioMenuOpen', { required: true })

const props = defineProps<{
  audioDevices: ReturnType<typeof useAudioDeviceStore>
  audioMenuLabel: string
  audioLatencyCaption: string | null
  quickSwitchDevices: readonly QuickSwitchDevice[]
  masterVolume: number
  setAudioMenuRoot: (el: Element | ComponentPublicInstance | null) => void
  toggleAudioMenu: () => void
  pickUniqueDevice: (device: QuickSwitchDevice) => void
  isCurrentUniqueDevice: (device: QuickSwitchDevice) => boolean
  onMasterVolumeInput: (event: Event) => void
}>()
</script>

<template>
  <div class="flex flex-1 items-center gap-3">
    <div
      :ref="props.setAudioMenuRoot"
      class="relative"
    >
      <button
        type="button"
        data-borderless-button="true"
        class="flex max-w-xs items-center gap-1.5 rounded border border-zinc-700 bg-zinc-950/40 px-2 py-1 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-900"
        :class="{
          'border-amber-700 text-amber-200': audioDevices.lastError,
          'animate-pulse': audioDevices.pendingSelection !== null
        }"
        :title="
          audioDevices.lastError
            ? audioDevices.lastError
            : audioLatencyCaption
              ? `Audio output: ${audioDevices.currentDeviceName || 'not set'} (${audioLatencyCaption} of output latency — playhead is auto-compensated during playback)`
              : 'Audio output device'
        "
        @click="toggleAudioMenu"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="h-3.5 w-3.5 shrink-0"
          aria-hidden="true"
        >
          <path d="M11 5L6 9H2v6h4l5 4V5z" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
        <span class="flex min-w-0 flex-col items-start leading-none">
          <span class="truncate text-xs">{{ audioMenuLabel }}</span>
          <span
            v-if="audioLatencyCaption"
            class="mt-0.5 text-[9px] tracking-wide text-zinc-500"
          >{{ audioLatencyCaption }}</span>
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          class="h-3 w-3 shrink-0 text-zinc-500"
          aria-hidden="true"
        >
          <path d="M4.427 6.427a.6.6 0 0 1 .849 0L8 9.151l2.724-2.724a.6.6 0 0 1 .849.849l-3.149 3.148a.6.6 0 0 1-.848 0L4.427 7.276a.6.6 0 0 1 0-.849Z" />
        </svg>
      </button>

      <div
        v-if="audioMenuOpen"
        class="silverdaw-scroll absolute left-0 top-full z-40 mt-1 max-h-80 w-80 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
      >
        <button
          v-for="device in quickSwitchDevices"
          :key="device.name"
          type="button"
          data-borderless-button="true"
          class="flex w-full items-center justify-between gap-3 px-3 py-1 text-left text-xs hover:bg-zinc-800"
          @click="pickUniqueDevice(device)"
        >
          <span class="truncate text-zinc-200">{{ device.name }}</span>
          <span
            v-if="isCurrentUniqueDevice(device)"
            class="text-sky-400"
            aria-hidden="true"
          >✓</span>
        </button>
        <p
          v-if="quickSwitchDevices.length === 0"
          class="px-3 py-1.5 text-xs text-zinc-500"
        >
          No output devices detected.
        </p>
        <div class="my-1 border-t border-zinc-800" />
        <button
          type="button"
          data-borderless-button="true"
          :disabled="audioDevices.rescanning"
          class="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] text-zinc-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          @click="audioDevices.requestRescan()"
        >
          <svg
            v-if="audioDevices.rescanning"
            class="h-3 w-3 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          {{ audioDevices.rescanning ? 'Rescanning…' : 'Rescan devices' }}
        </button>
      </div>
    </div>

    <div
      class="flex items-center gap-1.5"
      :title="`Master volume: ${formatLinearAsDb(masterVolume, { unit: true })}`"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-3.5 w-3.5 shrink-0 text-zinc-400"
        aria-hidden="true"
      >
        <path d="M3 10v4h4l5 4V6l-5 4H3z" />
        <path d="M16 8a5 5 0 0 1 0 8" />
      </svg>
      <input
        type="range"
        min="0"
        max="1"
        step="0.001"
        aria-label="Master volume"
        :value="linearToTaperPosition(masterVolume, MAX_MASTER_DB)"
        class="silverdaw-master-volume h-1 w-28 cursor-pointer appearance-none rounded bg-zinc-700 accent-sky-400 outline-none focus:outline-none focus-visible:outline-none"
        @input="onMasterVolumeInput($event)"
        @pointerup="($event.currentTarget as HTMLInputElement).blur()"
        @change="($event.currentTarget as HTMLInputElement).blur()"
      >
      <MasterMeter />
    </div>
  </div>
</template>
