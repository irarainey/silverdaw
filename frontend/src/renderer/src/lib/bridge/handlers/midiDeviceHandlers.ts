// MIDI-device-domain inbound handlers: seed the connected input-device list.

import { useMidiDeviceStore } from '@/stores/midiDeviceStore'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const midiDeviceBridgeHandlers: BridgeInboundHandlers<
  'MIDI_DEVICES_LIST' | 'MIDI_MESSAGE' | 'MIDI_CONTROL' | 'MIDI_DECK_SELECTION'
> = {
  MIDI_DEVICES_LIST: (payload) => {
    useMidiDeviceStore().applyList(payload)
  },
  MIDI_MESSAGE: (payload) => {
    useMidiDeviceStore().recordMessage(payload)
  },
  MIDI_CONTROL: (payload) => {
    useMidiDeviceStore().applyControl(payload)
  },
  MIDI_DECK_SELECTION: (payload) => {
    useMidiDeviceStore().applyDeckSelection(payload)
  }
}
