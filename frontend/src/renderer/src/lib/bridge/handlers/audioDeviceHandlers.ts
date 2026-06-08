// Audio-device-domain inbound handlers: device list seeding and active-device changes.

import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const audioDeviceBridgeHandlers: BridgeInboundHandlers<
  'AUDIO_DEVICES_LIST' | 'AUDIO_DEVICE_CHANGED'
> = {
  AUDIO_DEVICES_LIST: (payload) => {
    useAudioDeviceStore().applyList(payload)
  },

  AUDIO_DEVICE_CHANGED: (payload) => {
    useAudioDeviceStore().applyChanged(payload)
  }
}
