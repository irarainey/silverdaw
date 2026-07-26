import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import { loadScratchSourcePeaksFromCache } from '@/lib/bridge/peaksCache'

export const scratchSessionBridgeHandlers: BridgeInboundHandlers<
  'SCRATCH_SESSION_STATE' | 'SCRATCH_PATTERN_RECORDED' | 'SCRATCH_SOURCE_PEAKS_READY'
> = {
  SCRATCH_SESSION_STATE: (payload) => {
    useScratchSessionStore().applyState(payload)
  },
  SCRATCH_PATTERN_RECORDED: (payload) => {
    useScratchSessionStore().applyPatternRecorded(payload)
  },
  SCRATCH_SOURCE_PEAKS_READY: (payload) => {
    void loadScratchSourcePeaksFromCache(payload)
  }
}
