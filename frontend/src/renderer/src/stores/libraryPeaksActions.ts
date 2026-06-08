// Waveform / peaks-caching domain actions for the library store.
// Spread into the store; `this` is the store instance.

import { log } from '@/lib/log'
import { buildPeaksLodPyramid } from '@/lib/peaksLod'
import type { LibraryState } from './libraryTypes'

type PeaksThis = LibraryState

export const peaksActions = {
    /** Replaces peaks for PROJECT_STATE items once cached WAVEFORM_DATA arrives. */
    setItemPeaks(itemId: string, peaks: Float32Array, sampleRate: number, peaksPerSecond?: number): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      item.peaks = peaks
      if (typeof peaksPerSecond === 'number' && peaksPerSecond > 0) item.peaksPerSecond = peaksPerSecond
      if (sampleRate > 0) item.sampleRate = sampleRate
      // Build shared LOD after the current frame so peak watchers stay cheap.
      const itemPps = item.peaksPerSecond
      if (peaks.length >= 4 && typeof itemPps === 'number' && itemPps > 0) {
        const buildLod = (): void => {
          // Item may have been removed while queued.
          const live = this.items.find((i) => i.id === itemId)
          if (!live || live.peaks !== peaks) return
          live.peaksLod = buildPeaksLodPyramid(peaks, itemPps)
        }
        if (typeof queueMicrotask === 'function') queueMicrotask(buildLod)
        else buildLod()
      } else {
        item.peaksLod = undefined
      }
      log.debug('library', `setItemPeaks id=${itemId} peaks=${peaks.length / 2} sr=${sampleRate} pps=${item.peaksPerSecond ?? 'undef'}`)
    },

    /** Stores stereo peaks and per-channel LOD; non-stereo clears the entry. */
    setItemChannelPeaks(itemId: string, channels: Float32Array[], peaksPerSecond: number): void {
      if (!this.items.some((i) => i.id === itemId)) return
      if (channels.length !== 2 || !(peaksPerSecond > 0)) {
        delete this.channelPeaksByItemId[itemId]
        return
      }
      // Avoid rebuilding identical shared LOD pyramids for every clip waveform event.
      const existing = this.channelPeaksByItemId[itemId]
      if (
        existing &&
        existing.peaksPerSecond === peaksPerSecond &&
        existing.channels.length === channels.length &&
        existing.channels.every((ch, i) => ch === channels[i])
      ) {
        return
      }
      const lod = channels.map((ch) => buildPeaksLodPyramid(ch, peaksPerSecond))
      this.channelPeaksByItemId[itemId] = { channels, lod, peaksPerSecond }
      log.debug(
        'library',
        `setItemChannelPeaks id=${itemId} lanes=${channels.length} pps=${peaksPerSecond}`
      )
    },

    /** `null` clears the multi-MB Clip Editor peaks payload for GC. */
    setEditorHiResPeaks(
      payload: {
        libraryItemId: string
        peaksPerSecond: number
        sampleRate: number
        peaks: Float32Array
        channels: Float32Array[]
      } | null
    ): void {
      this.editorHiResPeaks = payload
    },
} satisfies Record<string, (this: PeaksThis, ...args: never[]) => unknown> &
  ThisType<PeaksThis>
