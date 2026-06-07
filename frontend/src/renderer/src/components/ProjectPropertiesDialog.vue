<script setup lang="ts">
// Transactional project settings dialog; local drafts commit only changed fields.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import {
  preferredBackendFor,
  useUniqueAudioDevices
} from '@/lib/audio/audioOutputPicker'
import { send as sendBridge } from '@/lib/bridgeService'
import { formatTime, parseTime } from '@/lib/musicTime'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const project = useProjectStore()
const transport = useTransportStore()
const notifications = useNotificationsStore()
const ui = useUiStore()
const audioDevices = useAudioDeviceStore()
const uniqueDevices = useUniqueAudioDevices()

const dialogEl = ref<HTMLDivElement | null>(null)
const nameInputRef = ref<HTMLInputElement | null>(null)

const BPM_MIN = 20
const BPM_MAX = 300

// Drafts are reseeded on open so Cancel discards changes.
const draftName = ref('')
const draftBpm = ref(120)
const draftDurationText = ref('')
const draftSampleRate = ref<number>(44100)
// `null` pair means no project override; unavailable saved devices remain selectable.
const draftAudioTypeName = ref<string | null>(null)
const draftAudioDeviceName = ref<string | null>(null)

const minDurationMs = computed(() => project.longestClipEndMs)
const minDurationLabel = computed(() => formatTime(minDurationMs.value))

const parsedDurationMs = computed(() => parseTime(draftDurationText.value))

interface AudioListOption {
  /** Empty string represents "System default". */
  value: string
  label: string
  /** Saved value no longer exposed by the OS. */
  unavailable: boolean
}

// Device options mirror Preferences and include unavailable saved devices.
const deviceOptions = computed<AudioListOption[]>(() => {
  const items: AudioListOption[] = [
    { value: '', label: 'System default', unavailable: false }
  ]
  for (const d of uniqueDevices.value) {
    items.push({ value: d.name, label: d.name, unavailable: false })
  }
  const savedDevice = project.audioOutputDeviceName
  if (
    savedDevice &&
    !uniqueDevices.value.some((d) => d.name.toLowerCase() === savedDevice.toLowerCase())
  ) {
    items.push({
      value: savedDevice,
      label: `${savedDevice} (not available)`,
      unavailable: true
    })
  }
  return items
})

// Driver options are scoped to the selected device plus any unavailable saved driver.
const driverOptions = computed<AudioListOption[]>(() => {
  const items: AudioListOption[] = []
  const deviceName = draftAudioDeviceName.value
  if (!deviceName) {
    // System default device has no explicit driver.
    items.push({ value: '', label: 'System default', unavailable: false })
    return items
  }
  const dev = uniqueDevices.value.find(
    (d) => d.name.toLowerCase() === deviceName.toLowerCase()
  )
  if (dev) {
    for (const b of dev.backends) {
      items.push({ value: b, label: b, unavailable: false })
    }
  }
  const savedType = project.audioOutputTypeName
  const savedDevice = project.audioOutputDeviceName
  if (
    savedType &&
    savedDevice &&
    savedDevice.toLowerCase() === deviceName.toLowerCase() &&
    !items.some((o) => o.value === savedType)
  ) {
    items.push({
      value: savedType,
      label: `${savedType} (not available)`,
      unavailable: true
    })
  }
  return items
})

// Select bindings map empty string to System default and auto-pick a preferred driver.
const draftAudioDeviceValue = computed<string>({
  get(): string {
    return draftAudioDeviceName.value ?? ''
  },
  set(v: string): void {
    const nextDevice = v.length > 0 ? v : null
    if (nextDevice === draftAudioDeviceName.value) return
    draftAudioDeviceName.value = nextDevice
    if (nextDevice === null) {
      draftAudioTypeName.value = null
      return
    }
    // Preserve explicit driver choice when it still exposes the chosen device.
    const dev = uniqueDevices.value.find(
      (d) => d.name.toLowerCase() === nextDevice.toLowerCase()
    )
    if (!dev) {
      // Unavailable tail entry: preserve driver; Save will not open it.
      return
    }
    const currentDriverStillValid =
      draftAudioTypeName.value !== null && dev.backends.includes(draftAudioTypeName.value)
    if (!currentDriverStillValid) {
      draftAudioTypeName.value = preferredBackendFor(dev)
    }
  }
})
const draftAudioTypeValue = computed<string>({
  get(): string {
    return draftAudioTypeName.value ?? ''
  },
  set(v: string): void {
    draftAudioTypeName.value = v.length > 0 ? v : null
  }
})

const audioPairInvalid = computed(() => {
  // Refuse impossible half-states from the paired dropdowns.
  const t = draftAudioTypeName.value
  const d = draftAudioDeviceName.value
  if (t === null && d === null) return false
  if (t !== null && d !== null) return false
  return true
})

const nameError = computed(() => {
  if (draftName.value.trim().length === 0) return 'Project name cannot be empty.'
  return null
})
const bpmError = computed(() => {
  const n = draftBpm.value
  if (!Number.isFinite(n)) return 'Tempo must be a number.'
  if (n < BPM_MIN || n > BPM_MAX) return `Tempo must be between ${BPM_MIN} and ${BPM_MAX} BPM.`
  return null
})
const durationError = computed(() => {
  const ms = parsedDurationMs.value
  if (ms === null) return 'Use mm:ss or h:mm:ss.'
  if (ms < minDurationMs.value) {
    return `Duration cannot be shorter than the last clip (${minDurationLabel.value}).`
  }
  return null
})

const hasNameChange = computed(() => draftName.value.trim() !== project.projectName)
const hasBpmChange = computed(() => {
  if (bpmError.value) return false
  return Math.abs(draftBpm.value - transport.bpm) > 0.001
})
const hasDurationChange = computed(() => {
  const ms = parsedDurationMs.value
  if (ms === null) return false
  return Math.abs(ms - project.durationMs) > 0.5
})
const hasAudioChange = computed(() =>
  draftAudioTypeName.value !== project.audioOutputTypeName ||
  draftAudioDeviceName.value !== project.audioOutputDeviceName
)
const hasSampleRateChange = computed(() => {
  const current = project.targetSampleRate ?? ui.defaultProjectSampleRate
  return draftSampleRate.value !== current
})

const hasAnyChange = computed(() =>
  hasNameChange.value || hasBpmChange.value || hasDurationChange.value ||
  hasAudioChange.value || hasSampleRateChange.value
)
const hasError = computed(() =>
  !!(nameError.value || bpmError.value || durationError.value) || audioPairInvalid.value
)
const canSave = computed(() => hasAnyChange.value && !hasError.value)

function initialiseDraft(): void {
  draftName.value = project.projectName
  draftBpm.value = Math.round(transport.bpm * 100) / 100
  draftDurationText.value = formatTime(project.durationMs)
  draftAudioTypeName.value = project.audioOutputTypeName
  draftAudioDeviceName.value = project.audioOutputDeviceName
  // Fall back to the user default without immediately persisting it.
  draftSampleRate.value = project.targetSampleRate ?? ui.defaultProjectSampleRate
}

function onSave(): void {
  if (!canSave.value) return
  const nextName = draftName.value.trim()
  const nextBpm = draftBpm.value
  const nextDurationMs = parsedDurationMs.value

  if (hasNameChange.value && nextName.length > 0) {
    project.requestRename(nextName)
  }
  if (hasBpmChange.value) {
    transport.setBpm(nextBpm)
    // Send the clamped renderer value.
    sendBridge('PROJECT_SET_BPM', { bpm: transport.bpm })
  }
  if (hasDurationChange.value && nextDurationMs !== null) {
    project.setProjectLengthMs(nextDurationMs)
    sendBridge('PROJECT_SET_LENGTH', { lengthMs: project.durationMs })
  }
  if (hasAudioChange.value) {
    const nextType = draftAudioTypeName.value
    const nextDevice = draftAudioDeviceName.value
    // Record the per-project preference, including nulls when clearing.
    project.setProjectAudioOutput(nextType, nextDevice)
    // Only open available pairs; unavailable picks are saved for load-time warning.
    let pairAvailable = false
    if (nextType === null && nextDevice === null) {
      pairAvailable = true
    } else if (nextType !== null && nextDevice !== null) {
      const dev = uniqueDevices.value.find(
        (d) => d.name.toLowerCase() === nextDevice.toLowerCase()
      )
      pairAvailable = dev !== undefined && dev.backends.includes(nextType)
    }
    const shouldSwitchLive =
      pairAvailable &&
      (audioDevices.currentTypeName !== nextType ||
        audioDevices.currentDeviceName !== nextDevice)
    if (shouldSwitchLive) {
      // Project preference only; leave user-scope preferences untouched.
      audioDevices.selectDevice(nextType, nextDevice, { persistUserPreference: false })
    }
  }
  if (hasSampleRateChange.value) {
    // Persist now; playback remains correct via per-track engine resampling.
    project.setTargetSampleRate(draftSampleRate.value)
  }
  notifications.pushInfo('Project properties saved.')
  emit('close')
}

function onCancel(): void {
  emit('close')
}

watch(
  () => props.open,
  async (now) => {
    // Reuse modal text-input flag to suppress transport/menu shortcuts.
    ui.clipEditorOpen = now
    if (now) {
      initialiseDraft()
      // Wait for the input to mount before focusing.
      await Promise.resolve()
      nameInputRef.value?.focus()
      nameInputRef.value?.select()
    }
  }
)

onMounted(() => {
  if (props.open) {
    ui.clipEditorOpen = true
    initialiseDraft()
  }
})

onBeforeUnmount(() => {
  if (props.open) ui.clipEditorOpen = false
})

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.preventDefault()
    onCancel()
  } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault()
    onSave()
  }
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
      aria-labelledby="project-properties-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(480px,92vw)]"
        @keydown="onKeydown"
      >
        <div class="dialog-header">
          <h1
            id="project-properties-title"
            class="dialog-title"
          >
            Project properties
          </h1>
        </div>

        <div class="dialog-body flex flex-col gap-4">
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Project name</span>
            <input
              ref="nameInputRef"
              v-model="draftName"
              type="text"
              maxlength="120"
              class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="nameError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="nameError"
              class="text-[11px] text-red-400"
            >{{ nameError }}</span>
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Tempo (BPM)</span>
            <input
              v-model.number="draftBpm"
              type="number"
              :min="BPM_MIN"
              :max="BPM_MAX"
              step="0.01"
              class="no-spinner w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="bpmError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="bpmError"
              class="text-[11px] text-red-400"
            >{{ bpmError }}</span>
            <span
              v-else
              class="text-[11px] text-zinc-500"
            >Range {{ BPM_MIN }} – {{ BPM_MAX }}. Affects warp + grid layout immediately.</span>
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Project duration</span>
            <input
              v-model="draftDurationText"
              type="text"
              inputmode="numeric"
              placeholder="mm:ss or h:mm:ss"
              class="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
              :class="durationError ? 'border-red-500' : ''"
              @keydown.enter.prevent="onSave"
            >
            <span
              v-if="durationError"
              class="text-[11px] text-red-400"
            >{{ durationError }}</span>
            <span
              v-else
              class="text-[11px] text-zinc-500"
            >Minimum {{ minDurationLabel }} (the end of the last clip).</span>
          </label>

          <!-- Project sample rate; engine resampling covers playback today. -->
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Sample rate</span>
            <select
              v-model.number="draftSampleRate"
              class="w-32 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
            >
              <option :value="44100">44 100 Hz</option>
              <option :value="48000">48 000 Hz</option>
            </select>
            <span class="text-[11px] text-zinc-500">
              Set the application default for new projects in <span class="text-zinc-300">Preferences ▸ Audio</span>.
            </span>
          </label>

          <!-- Audio output: device primary, driver override secondary. -->
          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Audio device</span>
            <select
              v-model="draftAudioDeviceValue"
              class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none"
            >
              <option
                v-for="opt in deviceOptions"
                :key="opt.value || 'system-default'"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
            <span class="text-[11px] text-zinc-500">
              Applied on every project load. Selecting <span class="text-zinc-300">System default</span> clears the project override so the global Preferences ▸ Audio device applies instead.
            </span>
          </label>

          <label class="flex flex-col gap-1.5">
            <span class="text-xs font-medium text-zinc-300">Audio driver</span>
            <select
              v-model="draftAudioTypeValue"
              :disabled="draftAudioDeviceName === null"
              class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:border-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option
                v-for="opt in driverOptions"
                :key="opt.value || 'system-default'"
                :value="opt.value"
              >
                {{ opt.label }}
              </option>
            </select>
          </label>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            :disabled="!canSave"
            @click="onSave"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Hide native number spinners; TransportBar already provides nudges. */
.no-spinner::-webkit-outer-spin-button,
.no-spinner::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.no-spinner {
  -moz-appearance: textfield;
  appearance: textfield;
}
</style>
