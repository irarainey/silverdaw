// Split-stereo-channels inbound handlers: completion and failure.
//
// The export is a fast file-write, so there's no progress dialog — a start toast
// (raised by the flow) and these result handlers are enough. The new tracks are
// created by the shared library-import / track-add flow (single source of truth).

import { createTracksFromChannelSplit, forgetChannelSplitJob } from '@/lib/stems/createChannelSplitTracks'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const channelSplitBridgeHandlers: BridgeInboundHandlers<
  'CHANNEL_SPLIT_READY' | 'CHANNEL_SPLIT_FAILED'
> = {
  CHANNEL_SPLIT_READY: async (payload) => {
    log.info(
      'channels',
      `ready jobId=${payload.jobId} channels=${payload.channels.map((c) => c.channel).join(',')}`
    )
    await createTracksFromChannelSplit(payload)
  },

  CHANNEL_SPLIT_FAILED: (payload) => {
    forgetChannelSplitJob(payload.jobId)
    useNotificationsStore().pushError(`Could not split channels: ${payload.error}`)
    log.error('channels', `failed jobId=${payload.jobId} code=${payload.code} error=${payload.error}`)
  }
}
