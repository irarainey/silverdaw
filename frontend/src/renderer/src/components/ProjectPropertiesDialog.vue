<script setup lang="ts">
// Project properties dialog. Consolidated edit surface for the three
// top-level project fields (name, tempo, duration) that are otherwise
// scattered across the title bar (rename) and the transport bar (BPM +
// length).
//
// Transactional: changes are held in local draft refs until Save. Cancel
// (and Esc / backdrop click) discard pending edits. Save dispatches only
// the bridge envelopes for the fields that actually changed; clamping
// rules mirror the source-of-truth setters (`transport.setBpm` clamps
// to 20..300, project length cannot drop below the longest clip's
// effective end).

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

// Draft state — reseeded from the store every time the dialog opens.
// Kept independent of the store so cancel really does cancel.
const draftName = ref('')
const draftBpm = ref(120)
const draftDurationText = ref('')
const draftSampleRate = ref<number>(44100)
// Audio output draft. `null` for both fields = "no project override"
// (the global preferences.json device applies on next load). When the
// project's currently saved device is not in the live device list we
// still surface it as a selectable entry so the user can keep / clear
// the saved preference without losing it.
const draftAudioTypeName = ref<string | null>(null)
const draftAudioDeviceName = ref<string | null>(null)

const minDurationMs = computed(() => project.longestClipEndMs)
const minDurationLabel = computed(() => formatTime(minDurationMs.value))

const parsedDurationMs = computed(() => parseTime(draftDurationText.value))

interface AudioListOption {
  /** Empty string represents "System default". */
  value: string
  label: string
  /** True when the option is the project's saved value but the OS no
   *  longer exposes it — kept selectable so the user can clear or
   *  keep the saved preference. */
  unavailable: boolean
}

// "Audio device" dropdown (the primary pick). Shows the same
// deduplicated `uniqueDevices` list the Preferences > Audio panel
// uses, so both surfaces agree on what devices exist (including
// e.g. DirectSound's "Primary Sound Driver"). Top entry: System
// default. Plus a tail "(not available)" entry when the project's
// saved device isn't in the live list.
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

// "Audio driver" (backend) dropdown — secondary pick that defaults
// to the most-preferred backend for the chosen device. Only shows
// backends that actually expose the picked device. Disabled when the
// device is "System default". Includes a "(not available)" tail
// entry when the project's saved driver is no longer on the
// machine but the picked device matches the saved device.
const driverOptions = computed<AudioListOption[]>(() => {
  const items: AudioListOption[] = []
  const deviceName = draftAudioDeviceName.value
  if (!deviceName) {
    // Device = System default → only "System default" driver applies.
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

// Convenience bindings for the two <select> v-models. Empty string =
// System default. The device dropdown also auto-picks the preferred
// backend when the user switches device, matching the Preferences
// dialog's "click a device, get the right driver for free" UX.
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
    // Auto-pick the most-preferred backend that exposes the chosen
    // device. Only override the existing driver pick when the
    // current driver doesn't actually offer this device — that lets
    // an advanced user keep their explicit backend choice across
    // device switches when it still applies.
    const dev = uniqueDevices.value.find(
      (d) => d.name.toLowerCase() === nextDevice.toLowerCase()
    )
    if (!dev) {
      // "(not available)" tail entry — leave the driver untouched.
      // Save will not try to open this pair.
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
  // "System default" means both null. A pinned device requires a
  // driver too; the dropdowns shouldn't produce a half-state but the
  // guard lets Save refuse it.
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
  // Seed the sample-rate draft from the project's stored value or,
  // when the project has none yet, fall back to the user-scope
  // application default. The combined rule means a freshly-created
  // project opens with the right initial pick without us having to
  // immediately persist the default.
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
    // `transport.setBpm` clamps internally; resend the clamped value
    // so the backend mirrors what the renderer settled on.
    sendBridge('PROJECT_SET_BPM', { bpm: transport.bpm })
  }
  if (hasDurationChange.value && nextDurationMs !== null) {
    project.setProjectLengthMs(nextDurationMs)
    sendBridge('PROJECT_SET_LENGTH', { lengthMs: project.durationMs })
  }
  if (hasAudioChange.value) {
    const nextType = draftAudioTypeName.value
    const nextDevice = draftAudioDeviceName.value
    // Record the per-project preference (also joins the project undo
    // stack via the backend's coalescing). Pass through nulls when
    // clearing.
    project.setProjectAudioOutput(nextType, nextDevice)
    // Apply the live device switch only when the chosen pair is
    // actually available — i.e. either System default (both null)
    // or a (type, device) where the device exists in `uniqueDevices`
    // and the chosen driver is one of the backends that exposes it.
    // A "(not available)" tail-entry pick records the project
    // preference but does NOT try to open the missing device; the
    // load-time reconcile will warn next time.
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
      // `persistUserPreference: false` keeps the user-scope
      // `preferences.json` device untouched — only the project
      // preference is the source of truth here.
      audioDevices.selectDevice(nextType, nextDevice, { persistUserPreference: false })
    }
  }
  if (hasSampleRateChange.value) {
    // Phase 1 of the per-project sample-rate feature only persists the
    // chosen rate on the project; the on-disk playback-cache rebuild
    // that actually downsamples existing clips lands in a follow-up.
    // Audio still plays correctly because every per-track
    // `AudioTransportSource` resamples to the device rate at the
    // engine. The Info dialog and import prompts honour the new value
    // immediately.
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
    // `clipEditorOpen` doubles as the suppression flag for the global
    // Spacebar (play / pause) and the menu accelerators — repurposed
    // for any modal dialog that hosts text input so typing 'p' / space
    // doesn't trigger transport actions.
    ui.clipEditorOpen = now
    if (now) {
      initialiseDraft()
      // Wait for the next tick so the input is in the DOM before we
      // try to focus + select it.
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
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-properties-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex w-[min(480px,92vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
        @keydown="onKeydown"
      >
        <!-- Header -->
        <div class="border-b border-zinc-800 px-6 py-4">
          <h1
            id="project-properties-title"
            class="text-base font-semibold tracking-tight text-zinc-100"
          >
            Project Properties
          </h1>
        </div>

        <!-- Body -->
        <div class="flex flex-col gap-4 px-6 py-5">
          <!-- Name -->
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

          <!-- Tempo -->
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

          <!-- Duration -->
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

          <!-- Project sample rate. Drives the playback-cache rebuild
               so every clip's audio is at this rate on disk (rebuild
               itself lands in a follow-up; today the rate is recorded
               and JUCE's per-track ResamplingAudioSource handles the
               engine-side conversion). -->
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

          <!-- Audio output: device + driver, in the same order as the
               Preferences ▸ Audio panel. Device is the primary pick
               and uses the shared deduplicated device list (so e.g.
               DirectSound's "Primary Sound Driver" appears once here
               too). Picking a device auto-selects the most-preferred
               backend that exposes it; the driver dropdown lets
               advanced users override that choice. -->
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

        <!-- Footer -->
        <div class="flex items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
          <button
            type="button"
            class="rounded bg-zinc-800 px-4 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700 focus:ring-2 focus:ring-sky-500 focus:outline-none"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded bg-sky-600 px-4 py-1 text-xs font-medium text-zinc-100 enabled:hover:bg-sky-500 focus:ring-2 focus:ring-sky-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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
/* Hide the WebKit / Blink number-input spinners. Vue's `v-model.number`
 * still parses the typed value, but the up/down arrows clutter the
 * narrow BPM input and the user can already nudge the value from the
 * TransportBar's dedicated BPM control. */
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
