import { watch } from 'vue'
import {
  handleMidiControl,
  suspendMidiControllerActions
} from '@/lib/midi/midiControllerActions'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'

/** Connect mapped MIDI state to operational transport actions for the app lifetime. */
export function useMidiControllerActions(isBlocked: () => boolean): void {
  const midiDevices = useMidiDeviceStore()
  watch(
    () => midiDevices.lastControl,
    (control) => {
      if (control && !isBlocked()) handleMidiControl(control)
    },
    // Avoid Vue batching multiple controller events into one lastControl observation.
    { flush: 'sync' }
  )
  watch(
    isBlocked,
    (blocked) => {
      if (blocked) suspendMidiControllerActions()
    },
    { flush: 'sync' }
  )
}
