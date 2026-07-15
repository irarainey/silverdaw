import { watch } from 'vue'
import {
  handleMidiControl,
  isMasterVolumeControl,
  suspendMidiControllerActions
} from '@/lib/midi/midiControllerActions'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'

/** Connect mapped MIDI state to operational transport actions for the app lifetime. */
export function useMidiControllerActions(isBlocked: () => boolean): void {
  const midiDevices = useMidiDeviceStore()
  watch(
    () => midiDevices.lastControl,
    (control) => {
      if (!control) return
      // A modal or editor dialog otherwise makes MIDI inert, but the master
      // volume still passes through so the main output level can be ridden from
      // the deck while working in the clip or scratch editor.
      if (isBlocked() && !isMasterVolumeControl(control)) return
      handleMidiControl(control)
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
