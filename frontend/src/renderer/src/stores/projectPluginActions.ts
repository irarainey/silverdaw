import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type { ProjectState } from './projectTypes'

/**
 * VST3 insert actions (ADR 0025). Every one of these is fire-and-forget: the backend owns the
 * plugin chain, so nothing here updates local state optimistically. Adding, removing and
 * reordering are confirmed by a `PROJECT_STATE` broadcast, because only the backend can mint
 * slot ids and clamp chain order. Bypass is confirmed by the narrower
 * `TRACK_PLUGIN_BYPASS_APPLIED` ack, which changes one flag rather than making the renderer
 * rebuild every track and clip to repaint one checkbox.
 */
export const pluginActions = {
  /** Ask the backend for the scanned catalogue (answered by PLUGIN_LIST). */
  requestPluginList(): void {
    sendBridge('PLUGIN_LIST_REQUEST')
  },

  /** Rescan the plugin folders. `retryFailed` also forgets plugins that previously failed. */
  scanPlugins(retryFailed = false): void {
    this.pluginScanning = true
    sendBridge('PLUGIN_SCAN', { clearBlacklist: retryFailed })
    log.debug('plugins', `scanPlugins retryFailed=${retryFailed}`)
  },

  addTrackPlugin(trackId: string, identifier: string): void {
    if (!this.tracks.some((track) => track.id === trackId) || identifier.length === 0) return
    sendBridge('TRACK_ADD_PLUGIN', { trackId, identifier })
    log.debug('plugins', `addTrackPlugin track=${trackId} identifier=${identifier}`)
  },

  removeTrackPlugin(trackId: string, slotId: string): void {
    if (slotId.length === 0) return
    sendBridge('TRACK_REMOVE_PLUGIN', { trackId, slotId })
  },

  /** `index` is the slot's new position in the track's chain, counted from zero. */
  reorderTrackPlugin(trackId: string, slotId: string, index: number): void {
    if (slotId.length === 0 || !Number.isFinite(index) || index < 0) return
    sendBridge('TRACK_REORDER_PLUGIN', { trackId, slotId, index: Math.trunc(index) })
  },

  setTrackPluginBypassed(trackId: string, slotId: string, bypassed: boolean): void {
    if (slotId.length === 0) return
    sendBridge('TRACK_SET_PLUGIN_BYPASS', { trackId, slotId, bypassed })
  },

  /**
   * Mirrors a bypass the backend has already applied, in response to
   * `TRACK_PLUGIN_BYPASS_APPLIED`. Local-only: it must never echo a command back, or a
   * bypass would bounce between the two processes forever.
   */
  applyTrackPluginBypassed(trackId: string, slotId: string, bypassed: boolean): void {
    const slot = this.tracks
      .find((t) => t.id === trackId)
      ?.plugins?.find((p) => p.slotId === slotId)
    if (!slot) return
    slot.bypassed = bypassed
  },

  /** Opens the plugin's own window, which the backend owns and draws. */
  openTrackPluginEditor(trackId: string, slotId: string): void {
    if (slotId.length === 0) return
    sendBridge('TRACK_OPEN_PLUGIN_EDITOR', { trackId, slotId })
  }
} satisfies Record<string, (this: ProjectState, ...args: never[]) => unknown> & ThisType<ProjectState>
