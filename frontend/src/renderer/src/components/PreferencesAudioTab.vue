<script setup lang="ts">
import { describeBackend, type UniqueDevice } from '@/lib/audio/audioOutputPicker'

defineProps<{
  uniqueDevices: readonly UniqueDevice[]
  audioOutputTypeName: string | null
  audioHasSelection: boolean
  isAudioOutputSelectedDevice: (deviceName: string) => boolean
  pickDevice: (device: UniqueDevice) => void
  pickSystemDefault: () => void
  backendsForSelectedDevice: readonly string[]
  pickBackend: (typeName: string) => void
  audioDevicesHydrated: boolean
  currentSampleRate: number | null
  currentBufferSize: number | null
  outputLatencyMs: number | null
  isBluetoothHeuristic: boolean
  lastError: string | null
  requestRescan: () => void
}>()

const defaultProjectSampleRate = defineModel<number>('defaultProjectSampleRate', { required: true })
const showAdvancedBackend = defineModel<boolean>('showAdvancedBackend', { required: true })
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
          class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
        >
          <input
            v-model="defaultProjectSampleRate"
            type="radio"
            name="default-project-sample-rate"
            :value="rate"
            class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
          >
          <span class="flex-1">
            <span class="block font-medium text-zinc-200">{{ rate.toLocaleString() }} Hz</span>
            <span class="mt-0.5 block text-zinc-500">
              <template v-if="rate === 44100">CD-quality default. Lower disk + CPU cost; matches most pop / streaming sources.</template>
              <template v-else>Video / production default. Use this when working with film, video or 48 kHz multitrack stems.</template>
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
        Pick where Silverdaw sends audio. Most users should leave this on
        <strong class="text-zinc-300">System default</strong> so it follows your
        Windows audio choice. Removable devices fall back to the default when
        unplugged and reconnect automatically next launch.
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
        <label class="flex cursor-pointer items-start gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2">
          <input
            type="radio"
            name="audio-output"
            :checked="!audioHasSelection"
            class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
            @change="pickSystemDefault"
          >
          <span class="flex-1">
            <span class="block font-medium text-zinc-200">System default</span>
            <span class="mt-0.5 block text-zinc-500">
              Follow whichever device Windows is currently routing audio to.
            </span>
          </span>
        </label>

        <div
          v-if="uniqueDevices.length === 0"
          class="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-zinc-600"
        >
          No output devices detected.
        </div>
        <label
          v-for="device in uniqueDevices"
          :key="device.name"
          class="flex cursor-pointer items-center gap-3 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2"
        >
          <input
            type="radio"
            name="audio-output"
            :checked="isAudioOutputSelectedDevice(device.name)"
            class="h-4 w-4 cursor-pointer accent-sky-500"
            @change="pickDevice(device)"
          >
          <span class="truncate text-zinc-200">{{ device.name }}</span>
        </label>
      </div>
    </div>

    <div
      v-if="audioDevicesHydrated && audioHasSelection && backendsForSelectedDevice.length > 1"
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
          class="flex cursor-pointer items-start gap-3 rounded px-2 py-1.5 hover:bg-zinc-900/60"
        >
          <input
            type="radio"
            name="audio-backend"
            :checked="audioOutputTypeName === backend"
            class="mt-0.5 h-4 w-4 cursor-pointer accent-sky-500"
            @change="pickBackend(backend)"
          >
          <span class="flex-1">
            <span class="block font-medium text-zinc-200">{{ backend }}</span>
            <span class="mt-0.5 block text-zinc-500">
              {{ describeBackend(backend) }}
            </span>
          </span>
        </label>
      </div>
    </div>

    <div
      v-if="audioDevicesHydrated"
      class="flex items-center justify-between text-zinc-500"
    >
      <span v-if="currentSampleRate">
        Current: {{ Math.round(currentSampleRate) }} Hz<template
          v-if="currentBufferSize"
        > / {{ currentBufferSize }}-sample buffer</template><template
          v-if="outputLatencyMs !== null && outputLatencyMs >= 30"
        > · ~{{ Math.round(outputLatencyMs) }} ms latency<template
          v-if="isBluetoothHeuristic"
        > (Bluetooth — playhead auto-compensates)</template></template>
      </span>
      <button
        type="button"
        class="rounded bg-zinc-800 px-3 py-1 text-[11px] font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none"
        @click="requestRescan"
      >
        Rescan devices
      </button>
    </div>

    <p
      v-if="lastError"
      class="rounded border border-amber-700 bg-amber-900/30 px-3 py-2 text-amber-200"
    >
      {{ lastError }}
    </p>
  </section>
</template>
