import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'
import { loadRecordingPeaksFromCache } from '@/lib/bridge/peaksCache'

export const recordingBridgeHandlers: BridgeInboundHandlers<
  'RECORD_INPUTS_LIST' | 'RECORD_SESSION_STATE' | 'RECORD_INPUT_LEVEL' | 'RECORD_RECORDING_READY'
> = {
  RECORD_INPUTS_LIST: (payload) => {
    useRecordingSessionStore().applyInputs(payload)
  },
  RECORD_SESSION_STATE: (payload) => {
    useRecordingSessionStore().applyState(payload)
  },
  RECORD_INPUT_LEVEL: (payload) => {
    useRecordingSessionStore().applyInputLevel(payload)
  },
  RECORD_RECORDING_READY: (payload) => {
    useRecordingSessionStore().applyRecordingReady(payload)
    void loadRecordingPeaksFromCache(payload)
  }
}
