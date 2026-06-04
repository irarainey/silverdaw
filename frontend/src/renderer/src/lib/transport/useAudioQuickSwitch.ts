// Audio-output device quick-switch for the transport bar, extracted from
// TransportBar.vue. A compact chip shows the current output device; clicking
// opens a popover listing every device (deduped per physical device, mirroring
// the Preferences > Audio tab) plus a "System default" entry. Picking a device
// routes through the same `audioDeviceStore.selectDevice` action the
// Preferences tab uses and pins the choice to the open project.
//
// The SFC keeps ownership of the document mousedown/keydown listeners (so the
// popover closes on outside-click / Escape) — this module supplies the
// handlers and the menu state.
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'

export interface QuickSwitchDevice {
  name: string
  backends: string[]
}

export interface AudioQuickSwitch {
  audioMenuOpen: Ref<boolean>
  audioMenuRoot: Ref<HTMLElement | null>
  audioMenuLabel: ComputedRef<string>
  audioLatencyCaption: ComputedRef<string | null>
  quickSwitchDevices: ComputedRef<QuickSwitchDevice[]>
  preferredBackendForQuickSwitch: (device: QuickSwitchDevice) => string
  toggleAudioMenu: () => void
  pickDevice: (typeName: string | null, deviceName: string | null) => void
  pickUniqueDevice: (device: QuickSwitchDevice) => void
  isCurrentDevice: (typeName: string | null, deviceName: string | null) => boolean
  isCurrentUniqueDevice: (device: QuickSwitchDevice) => boolean
  onAudioMenuDocClick: (e: MouseEvent) => void
  onAudioMenuKey: (e: KeyboardEvent) => void
}

/** Same backend-preference ordering as the Preferences dialog. */
const QUICK_SWITCH_BACKEND_PRIORITY = [
  'Windows Audio',
  'CoreAudio',
  'ALSA',
  'DirectSound',
  'Windows Audio (Exclusive Mode)',
  'JACK',
  'ASIO'
]

export function useAudioQuickSwitch(): AudioQuickSwitch {
  const project = useProjectStore()
  const audioDevices = useAudioDeviceStore()

  const audioMenuOpen = ref(false)
  const audioMenuRoot = ref<HTMLElement | null>(null)

  const audioMenuLabel = computed(() => {
    // Show the *target* device name immediately on click rather than a
    // verbose "Switching to X…" string. Optimistic update — when the
    // backend acks (the round-trip is ~50–300 ms on Windows depending
    // on driver), the `pendingSelection` clears and we fall through to
    // the live `currentDeviceName` which is the same string. If the
    // switch fails, `audioDevices.lastError` flips and the chip border
    // goes amber, but the label still reads the device the user picked
    // so the failure is obvious in context rather than via a label flip.
    const pending = audioDevices.pendingSelection
    if (pending) {
      if (!pending.typeName && !pending.deviceName) return 'System default'
      return pending.deviceName || 'System default'
    }
    if (audioDevices.onSystemDefault) return 'System default'
    return audioDevices.currentDeviceName || 'System default'
  })

  // Latency caption shown under the device name in the chip when the active
  // device has a meaningful end-to-end delay (>30 ms). Stays hidden for
  // low-latency wired / ASIO devices so the chip doesn't feel busy.
  const audioLatencyCaption = computed<string | null>(() => {
    const ms = audioDevices.outputLatencyMs
    if (ms === null || ms < 30) return null
    const rounded = Math.round(ms)
    return audioDevices.isBluetoothHeuristic ? `~${rounded} ms · BT` : `${rounded} ms`
  })

  // Unique-device list for the quick-switch popover. Identical dedupe rule to
  // PreferencesDialog.vue — same physical device exposed by multiple Windows
  // backends collapses into one row.
  const quickSwitchDevices = computed<QuickSwitchDevice[]>(() => {
    const map = new Map<string, QuickSwitchDevice>()
    for (const type of audioDevices.types) {
      for (const dev of type.devices) {
        const key = dev.toLowerCase()
        const existing = map.get(key)
        if (existing) {
          if (!existing.backends.includes(type.name)) existing.backends.push(type.name)
        } else {
          map.set(key, { name: dev, backends: [type.name] })
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  })

  function preferredBackendForQuickSwitch(device: QuickSwitchDevice): string {
    for (const b of QUICK_SWITCH_BACKEND_PRIORITY) {
      if (device.backends.includes(b)) return b
    }
    return device.backends[0] ?? ''
  }

  function toggleAudioMenu(): void {
    audioMenuOpen.value = !audioMenuOpen.value
  }

  function pickDevice(typeName: string | null, deviceName: string | null): void {
    audioDevices.selectDevice(typeName, deviceName)
    // Pin the choice to the open project so it travels with the file and
    // marks the project dirty (but isn't auto-saved). Picking "System
    // default" (both null) clears the pin, so a previously-saved device
    // that's missing on this machine won't be re-requested next launch.
    project.setProjectAudioOutput(typeName, deviceName)
    audioMenuOpen.value = false
  }

  function pickUniqueDevice(device: QuickSwitchDevice): void {
    // Auto-pick the most-friendly backend for the chosen device. The
    // transport-bar popover deliberately doesn't expose the backend
    // distinction — advanced users who want ASIO use Preferences →
    // Audio → Audio driver instead.
    pickDevice(preferredBackendForQuickSwitch(device), device.name)
  }

  function isCurrentDevice(typeName: string | null, deviceName: string | null): boolean {
    const activeType = audioDevices.pendingSelection?.typeName ?? audioDevices.currentTypeName
    const activeDevice = audioDevices.pendingSelection?.deviceName ?? audioDevices.currentDeviceName
    return activeType === typeName && activeDevice === deviceName
  }

  function isCurrentUniqueDevice(device: QuickSwitchDevice): boolean {
    const activeDevice = audioDevices.pendingSelection?.deviceName ?? audioDevices.currentDeviceName
    return !!activeDevice && activeDevice.toLowerCase() === device.name.toLowerCase()
  }

  function onAudioMenuDocClick(e: MouseEvent): void {
    if (!audioMenuRoot.value) return
    if (!audioMenuRoot.value.contains(e.target as Node)) audioMenuOpen.value = false
  }

  function onAudioMenuKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') audioMenuOpen.value = false
  }

  return {
    audioMenuOpen,
    audioMenuRoot,
    audioMenuLabel,
    audioLatencyCaption,
    quickSwitchDevices,
    preferredBackendForQuickSwitch,
    toggleAudioMenu,
    pickDevice,
    pickUniqueDevice,
    isCurrentDevice,
    isCurrentUniqueDevice,
    onAudioMenuDocClick,
    onAudioMenuKey
  }
}
