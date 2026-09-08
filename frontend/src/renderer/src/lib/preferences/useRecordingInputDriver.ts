// The recording input driver preference (ADR 0030).
//
// Windows exposes the same microphone through several drivers, and which one is
// best is a machine-wide setup decision, not something to decide again every time
// the Record Audio dialog opens. It therefore lives here, next to the output
// driver, and the dialog just uses whatever this resolves to.

import { computed, onMounted, ref, type ComputedRef } from 'vue'
import { sortByBackendPreference } from '@/lib/audio/audioOutputPicker'
import { send as sendBridge } from '@/lib/bridgeService'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'

/** Value of the "let Silverdaw choose" option. */
export const AUTOMATIC_INPUT_DRIVER = ''

export interface RecordingInputDriverPreference {
  /** Driver names offering at least one input device, most-preferred first. */
  driverNames: ComputedRef<string[]>
  /** The stored driver, or `AUTOMATIC_INPUT_DRIVER` when none is pinned. */
  selected: ComputedRef<string>
  /** Pin a driver, or pass `AUTOMATIC_INPUT_DRIVER` to go back to automatic. */
  pick(typeName: string): void
}

export function useRecordingInputDriver(): RecordingInputDriverPreference {
  const store = useRecordingSessionStore()
  const storedTypeName = ref('')
  const storedDeviceName = ref<string | null>(null)

  onMounted(() => {
    // Enumerating inputs needs no session: the backend answers from the device
    // manager, so nothing is opened and no microphone is held. The answer is
    // cached both sides, so re-opening Preferences costs nothing.
    if (store.inputs === null) sendBridge('RECORD_INPUTS_REQUEST', {})
    void window.silverdaw
      .getAudioInput()
      .then((saved) => {
        storedTypeName.value = saved?.typeName ?? ''
        storedDeviceName.value = saved?.deviceName ?? null
      })
      .catch(() => undefined)
  })

  const driverNames = computed(() => {
    const names = (store.inputs?.types ?? [])
      .filter((type) => type.devices.length > 0)
      .map((type) => type.name)
    return sortByBackendPreference(names)
  })

  const selected = computed(() =>
    driverNames.value.includes(storedTypeName.value)
      ? storedTypeName.value
      : AUTOMATIC_INPUT_DRIVER
  )

  return {
    driverNames,
    selected,

    pick(typeName: string): void {
      storedTypeName.value = typeName
      store.preferredInputTypeName = typeName === AUTOMATIC_INPUT_DRIVER ? null : typeName
      // The device is kept: the same microphone is normally offered by every
      // driver that lists it, and an empty driver lets the backend choose.
      window.silverdaw.setAudioInput({
        typeName: store.preferredInputTypeName,
        deviceName: storedDeviceName.value
      })
    }
  }
}
