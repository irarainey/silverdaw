import { watch } from 'vue'
import { handleMidiControl } from '@/lib/midi/midiControllerActions'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'

/** Connect mapped MIDI state to operational transport actions for the app lifetime. */
export function useMidiControllerActions(): void {
  const midiDevices = useMidiDeviceStore()
  watch(
    () => midiDevices.lastControl,
    (control) => {
      if (control) handleMidiControl(control)
    },
    // Avoid Vue batching multiple controller events into one lastControl observation.
    { flush: 'sync' }
  )
}
