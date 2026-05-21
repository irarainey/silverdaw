import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'

/**
 * State of the Clip Editor's preview voice — an independent backend
 * playback path that plays a single library item (optionally windowed
 * to a [inMs, inMs + durationMs] selection of the source). Mirrors what
 * the backend reports via `PREVIEW_STATE` and `PREVIEW_POSITION`.
 *
 * The store gates incoming envelopes on a monotonic `generation`
 * counter the backend bumps on every load/unload, so a stale state
 * broadcast targeting a preview the user has already closed is
 * silently dropped.
 */
export const usePreviewStore = defineStore('preview', {
  state: () => ({
    /** Library item currently loaded into the preview voice, or null when idle. */
    itemId: null as string | null,
    /** Selection start (ms in source). */
    inMs: 0,
    /** Selection length (ms). 0 means "to end of source". */
    durationMs: 0,
    /** Playhead position in ms, relative to selection start. */
    positionMs: 0,
    /** True while the preview transport is playing. */
    isPlaying: false,
    /** True between PREVIEW_LOAD (acked via PREVIEW_STATE) and PREVIEW_UNLOAD. */
    isLoaded: false,
    /** Mirror of the backend's preview generation. Inbound envelopes with a
     *  lower generation are discarded. */
    generation: 0,
    /** Monotonic counter that bumps on every inbound `PREVIEW_ENDED`. The
     *  Clip Editor watches this so loop playback can restart cleanly
     *  even though `applyEnded` resets `positionMs` to 0. */
    endedCount: 0
  }),
  actions: {
    /** Begin a new preview session for `itemId`, windowed to [inMs, inMs+durationMs].
     *  Resets local state immediately so the dialog UI is responsive even
     *  before the backend has finished loading the source. */
    load(itemId: string, inMs: number, durationMs: number): void {
      this.itemId = itemId
      this.inMs = inMs
      this.durationMs = durationMs
      this.positionMs = 0
      this.isPlaying = false
      this.isLoaded = false
      sendBridge('PREVIEW_LOAD', { libraryItemId: itemId, inMs, durationMs })
    },
    /** Tear down the current preview session and tell the backend to release
     *  its reader. Safe to call when already unloaded. */
    unload(): void {
      if (!this.itemId && !this.isLoaded) return
      sendBridge('PREVIEW_UNLOAD')
      this.itemId = null
      this.isLoaded = false
      this.isPlaying = false
      this.positionMs = 0
    },
    play(): void {
      if (!this.isLoaded) return
      this.isPlaying = true
      sendBridge('PREVIEW_PLAY')
    },
    pause(): void {
      if (!this.isPlaying) return
      this.isPlaying = false
      sendBridge('PREVIEW_PAUSE')
    },
    stop(): void {
      this.isPlaying = false
      this.positionMs = 0
      sendBridge('PREVIEW_STOP')
    },
    seek(ms: number): void {
      const clamped = Math.max(0, Math.min(ms, this.durationMs > 0 ? this.durationMs : ms))
      this.positionMs = clamped
      sendBridge('PREVIEW_SEEK', { positionMs: clamped })
    },
    /** Apply an inbound `PREVIEW_STATE` envelope. Ignored if its generation
     *  is older than the one we've already seen. */
    applyState(payload: {
      libraryItemId?: string
      isPlaying: boolean
      isLoaded: boolean
      durationMs: number
      generation: number
    }): void {
      if (payload.generation < this.generation) {
        log.debug('preview', `stale PREVIEW_STATE gen=${payload.generation} < ${this.generation}`)
        return
      }
      this.generation = payload.generation
      this.isLoaded = payload.isLoaded
      this.isPlaying = payload.isPlaying
      if (payload.durationMs > 0) this.durationMs = payload.durationMs
      if (!payload.isLoaded) {
        this.positionMs = 0
        this.itemId = null
      }
    },
    /** Apply an inbound `PREVIEW_POSITION` envelope. */
    applyPosition(payload: { positionMs: number; isPlaying: boolean; generation: number }): void {
      if (payload.generation < this.generation) return
      this.positionMs = payload.positionMs
      this.isPlaying = payload.isPlaying
    },
    /** Apply an inbound `PREVIEW_ENDED` envelope: window finished playing. */
    applyEnded(payload: { generation: number }): void {
      if (payload.generation < this.generation) return
      this.isPlaying = false
      this.positionMs = 0
      this.endedCount++
    }
  }
})
