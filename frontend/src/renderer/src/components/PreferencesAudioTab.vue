<script setup lang="ts">
import { describeBackend, type UniqueDevice } from '@/lib/audio/audioOutputPicker'

const props = defineProps<{
  uniqueDevices: readonly UniqueDevice[]
  audioOutputTypeName: string | null
  isAudioOutputSelectedDevice: (deviceName: string) => boolean
  pickDevice: (device: UniqueDevice) => void
  backendsForSelectedDevice: readonly string[]
  pickBackend: (typeName: string) => void
  audioDevicesHydrated: boolean
  rescanning: boolean
  lastError: string | null
  requestRescan: () => void
  /** Draft per-device keep-awake toggles (device name → true); absent = off. */
  keepAwakeByDevice: Record<string, boolean>
  /** Enable / disable a device's keep-awake toggle. */
  setDeviceKeepAwake: (deviceName: string, enabled: boolean) => void
}>()

const defaultProjectSampleRate = defineModel<number>('defaultProjectSampleRate', { required: true })
const showAdvancedBackend = defineModel<boolean>('showAdvancedBackend', { required: true })

function onKeepAwakeChange(deviceName: string, event: Event): void {
  props.setDeviceKeepAwake(deviceName, (event.target as HTMLInputElement).checked)
}
</script>

<template>
  <section class="space-y-4">
    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Default project sample rate
      </h2>
      <p class="mb-3 text-zinc-500">
        Applied to projects you create from now on. Existing projects keep their own stored rate. Change a project's rate from
        <strong class="text-zinc-300">File ▸ Project Properties…</strong>.
      </p>
      <div class="space-y-2">
        <label
          v-for="rate in [44100, 48000]"
          :key="rate"
          class="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <input
            v-model="defaultProjectSampleRate"
            type="radio"
            name="default-project-sample-rate"
            :value="rate"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">{{ rate.toLocaleString() }} Hz</span>
            <span class="text-zinc-500">
              <template v-if="rate === 44100"> — CD quality, lighter load</template>
              <template v-else> — Video and broadcast standard</template>
            </span>
          </span>
        </label>
      </div>
    </div>

    <div>
      <h2 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
        Output device
      </h2>
      <p class="mb-3 text-zinc-500">
        Pick which device Silverdaw plays through. Removable devices fall back to the
        next available one when unplugged, and reconnect automatically next launch.
        Tick <strong class="text-zinc-300">Keep awake</strong> for a device that
        sleeps and clips the first beat (typically a USB DAC) — it's off by default
        and remembered per device, even while it's unplugged.
      </p>

      <div
        v-if="!audioDevicesHydrated"
        class="text-zinc-500"
      >
        Loading device list…
      </div>
      <div
        v-else
        class="space-y-2"
      >
        <div
          v-if="uniqueDevices.length === 0"
          class="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5 text-zinc-600"
        >
          No output devices detected.
        </div>
        <div
          v-for="device in uniqueDevices"
          :key="device.name"
          class="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2.5"
        >
          <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
            <input
              type="radio"
              name="audio-output"
              :checked="isAudioOutputSelectedDevice(device.name)"
              class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
              @change="pickDevice(device)"
            >
            <span class="min-w-0 flex-1 truncate text-zinc-200">{{ device.name }}</span>
          </label>
          <label
            class="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400"
            title="Keep awake: send an inaudible signal so a sleep-prone USB device doesn't sleep and clip the first beat. Off by default; turn on only for a device that needs it."
          >
            <input
              type="checkbox"
              :checked="keepAwakeByDevice[device.name] === true"
              class="h-3.5 w-3.5 shrink-0 cursor-pointer accent-sky-500"
              @change="onKeepAwakeChange(device.name, $event)"
            >
            Keep awake
          </label>
        </div>
      </div>
    </div>

    <div
      v-if="audioDevicesHydrated"
      class="flex justify-end"
    >
      <button
        type="button"
        :disabled="rescanning"
        class="flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        @click="requestRescan"
      >
        <svg
          v-if="rescanning"
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
        {{ rescanning ? 'Rescanning…' : 'Rescan devices' }}
      </button>
    </div>

    <div
      v-if="audioDevicesHydrated && backendsForSelectedDevice.length > 1"
    >
      <button
        type="button"
        class="flex items-center gap-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-200"
        data-borderless-button="true"
        @click="showAdvancedBackend = !showAdvancedBackend"
      >
        <span
          aria-hidden="true"
          class="inline-block w-3 text-center"
        >{{ showAdvancedBackend ? '▾' : '▸' }}</span>
        Audio driver ({{ audioOutputTypeName }})
      </button>
      <div
        v-if="showAdvancedBackend"
        class="mt-2 space-y-2 rounded border border-zinc-800 bg-zinc-950/40 p-2"
      >
        <p class="text-zinc-500">
          Windows offers several backends for the same physical device. Stick with
          the recommended one unless you have a reason to change.
        </p>
        <label
          v-for="backend in backendsForSelectedDevice"
          :key="backend"
          class="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-zinc-900/60"
        >
          <input
            type="radio"
            name="audio-backend"
            :checked="audioOutputTypeName === backend"
            class="h-4 w-4 shrink-0 cursor-pointer accent-sky-500"
            @change="pickBackend(backend)"
          >
          <span class="min-w-0 flex-1 truncate leading-tight">
            <span class="font-medium text-zinc-200">{{ backend }}</span>
            <span class="text-zinc-500"> — {{ describeBackend(backend) }}</span>
          </span>
        </label>
      </div>
    </div>

    <p
      v-if="lastError"
      class="rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-amber-200"
    >
      {{ lastError }}
    </p>
  </section>
</template>
