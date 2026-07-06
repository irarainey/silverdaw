import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import {
  preferredBackendFor,
  useUniqueAudioDevices
} from '@/lib/audio/audioOutputPicker'
import { send as sendBridge } from '@/lib/bridgeService'
import { formatTime, parseTime } from '@/lib/musicTime'

export type ProjectPropertiesProps = { open: boolean }

type ProjectPropertiesEmit = (e: 'close') => void

export function useProjectPropertiesController(
  props: Readonly<ProjectPropertiesProps>,
  emit: ProjectPropertiesEmit,
  nameInputRef: Ref<HTMLInputElement | null>
) {
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const audioDevices = useAudioDeviceStore()
  const uniqueDevices = useUniqueAudioDevices()

  const BPM_MIN = 20
  const BPM_MAX = 300
  const BAR_COUNTER_START_MIN = -64
  const BAR_COUNTER_START_MAX = 1

  // Drafts are reseeded on open so Cancel discards changes.
  const draftName = ref('')
  const draftBpm = ref(120)
  const draftDurationText = ref('')
  const draftSampleRate = ref<number>(44100)
  const draftBarCounterStart = ref(1)
  // `null` pair means no project override; unavailable saved devices remain selectable.
  const draftAudioTypeName = ref<string | null>(null)
  const draftAudioDeviceName = ref<string | null>(null)

  const minDurationMs = computed(() => project.longestClipEndMs)
  const minDurationLabel = computed(() => formatTime(minDurationMs.value))

  const parsedDurationMs = computed(() => parseTime(draftDurationText.value))

  interface AudioListOption {
    /** Empty string represents "Use Application Settings" (no project override). */
    value: string
    label: string
    /** Saved value no longer exposed by the OS. */
    unavailable: boolean
  }

  // Device options mirror Preferences and include unavailable saved devices.
  const deviceOptions = computed<AudioListOption[]>(() => {
    const items: AudioListOption[] = [
      { value: '', label: 'Use Application Settings', unavailable: false }
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
      // Inheriting the application settings has no explicit driver.
      items.push({ value: '', label: 'Use Application Settings', unavailable: false })
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

  // Select bindings map empty string to "Use Application Settings" and auto-pick a preferred driver.
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
    // The field only expresses whole seconds (formatTime floors), so compare
    // against the second-floored minimum — otherwise the displayed value for a
    // sub-second clip end (e.g. "3:05" for 185432 ms) parses back below the raw
    // float minimum and falsely errors. setProjectLengthMs clamps up to the
    // true longest-clip end regardless, so this can't truncate a clip.
    const minMs = Math.floor(minDurationMs.value / 1000) * 1000
    if (ms < minMs) {
      return `Duration cannot be shorter than the last clip (${minDurationLabel.value}).`
    }
    return null
  })

  const barCounterStartError = computed(() => {
    const n = draftBarCounterStart.value
    if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Bar start must be a whole number.'
    if (n < BAR_COUNTER_START_MIN || n > BAR_COUNTER_START_MAX) {
      return `Bar start must be between ${BAR_COUNTER_START_MIN} and ${BAR_COUNTER_START_MAX}.`
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
  const hasBarCounterStartChange = computed(() => {
    if (barCounterStartError.value) return false
    return draftBarCounterStart.value !== project.barCounterStart
  })

  const hasAnyChange = computed(() =>
    hasNameChange.value || hasBpmChange.value || hasDurationChange.value ||
    hasAudioChange.value || hasSampleRateChange.value || hasBarCounterStartChange.value
  )
  const hasError = computed(() =>
    !!(nameError.value || bpmError.value || durationError.value || barCounterStartError.value) ||
    audioPairInvalid.value
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
    draftBarCounterStart.value = project.barCounterStart
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
    if (hasBarCounterStartChange.value) {
      project.setBarCounterStart(draftBarCounterStart.value)
    }
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

  return {
    BPM_MIN,
    BPM_MAX,
    BAR_COUNTER_START_MIN,
    BAR_COUNTER_START_MAX,
    draftName,
    draftBpm,
    draftDurationText,
    draftSampleRate,
    draftBarCounterStart,
    draftAudioDeviceName,
    minDurationLabel,
    deviceOptions,
    driverOptions,
    draftAudioDeviceValue,
    draftAudioTypeValue,
    nameError,
    bpmError,
    durationError,
    barCounterStartError,
    canSave,
    onSave,
    onCancel,
    onKeydown
  }
}
