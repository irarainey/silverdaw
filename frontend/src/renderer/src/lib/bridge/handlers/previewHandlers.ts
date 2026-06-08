// Preview-domain inbound handlers: clip-preview state, position, and completion.

import { usePreviewStore } from '@/stores/previewStore'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const previewBridgeHandlers: BridgeInboundHandlers<
  'PREVIEW_STATE' | 'PREVIEW_POSITION' | 'PREVIEW_ENDED'
> = {
  PREVIEW_STATE: (payload) => {
    usePreviewStore().applyState(payload)
  },

  PREVIEW_POSITION: (payload) => {
    usePreviewStore().applyPosition(payload)
  },

  PREVIEW_ENDED: (payload) => {
    usePreviewStore().applyEnded(payload)
  }
}
