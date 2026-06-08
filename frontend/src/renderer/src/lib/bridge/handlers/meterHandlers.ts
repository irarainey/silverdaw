// Meter-domain inbound handlers: master and per-track level updates routed to the
// non-reactive meter channels so 60 Hz traffic bypasses Pinia fan-out.

import { setMasterLevels } from '@/lib/audio/masterLevelChannel'
import { setTrackLevels } from '@/lib/audio/trackLevelsChannel'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const meterBridgeHandlers: BridgeInboundHandlers<'MASTER_LEVEL' | 'TRACK_LEVELS'> = {
  MASTER_LEVEL: (payload) => {
    setMasterLevels(payload.peakL, payload.peakR)
  },

  TRACK_LEVELS: (payload) => {
    setTrackLevels(payload.tracks)
  }
}
