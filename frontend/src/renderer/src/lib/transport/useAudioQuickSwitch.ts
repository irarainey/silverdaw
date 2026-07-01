// Audio-output device quick-switch for the transport bar, extracted from
// TransportBar.vue. A compact chip shows the current output device; clicking
// opens a popover listing the real named devices (deduped per physical device
// and pseudo-endpoints filtered — the same shared list as Preferences ▸ Audio).
// Picking a device routes through the same `audioDeviceStore.selectDevice` action
// the Preferences tab uses and pins the choice to the open project.
//
// The SFC keeps ownership of the document mousedown/keydown listeners (so the
// popover closes on outside-click / Escape) — this module supplies the
// handlers and the menu state.
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { preferredBackendFor, useUniqueAudioDevices } from '@/lib/audio/audioOutputPicker'

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
  pickUniqueDevice: (device: QuickSwitchDevice) => void
  isCurrentUniqueDevice: (device: QuickSwitchDevice) => boolean
  onAudioMenuDocClick: (e: MouseEvent) => void
  onAudioMenuKey: (e: KeyboardEvent) => void
}

/** Same backend-preference ordering as the Preferences dialog. */
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
    if (pending?.deviceName) return pending.deviceName
    return audioDevices.currentDeviceName || 'Audio output'
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

  // Real named devices for the quick-switch popover — the shared, pseudo-device-filtered
  // list used by Preferences ▸ Audio, so both surfaces list exactly the same devices.
  const quickSwitchDevices = useUniqueAudioDevices()

  function preferredBackendForQuickSwitch(device: QuickSwitchDevice): string {
    return preferredBackendFor(device)
  }

  function toggleAudioMenu(): void {
    audioMenuOpen.value = !audioMenuOpen.value
  }

  function pickUniqueDevice(device: QuickSwitchDevice): void {
    // Auto-pick the most-friendly backend for the chosen device. The transport-bar
    // popover deliberately doesn't expose the backend distinction — advanced users
    // who want ASIO use Preferences → Audio → Audio driver instead.
    const typeName = preferredBackendForQuickSwitch(device)
    audioDevices.selectDevice(typeName, device.name)
    // Pin the choice to the open project so it travels with the file and marks the
    // project dirty (but isn't auto-saved).
    project.setProjectAudioOutput(typeName, device.name)
    audioMenuOpen.value = false
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
    pickUniqueDevice,
    isCurrentUniqueDevice,
    onAudioMenuDocClick,
    onAudioMenuKey
  }
}
