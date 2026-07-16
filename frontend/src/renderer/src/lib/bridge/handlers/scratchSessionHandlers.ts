import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'

export const scratchSessionBridgeHandlers: BridgeInboundHandlers<'SCRATCH_SESSION_STATE' | 'SCRATCH_PATTERN_RECORDED'> = {
  SCRATCH_SESSION_STATE: (payload) => {
    useScratchSessionStore().applyState(payload)
  },
  SCRATCH_PATTERN_RECORDED: (payload) => {
    useScratchSessionStore().applyPatternRecorded(payload)
  }
}
