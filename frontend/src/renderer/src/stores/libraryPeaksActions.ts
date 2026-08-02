// Waveform / peaks-caching domain actions for the library store.
// Spread into the store; `this` is the store instance.

import { log } from '@/lib/log'
import { buildPeaksLodPyramid } from '@/lib/peaksLod'
import { filePathKey } from './projectHelpers'
import type { ItemChannelPeaks, LibraryState } from './libraryTypes'
import type { PeaksLodLayer } from '@/lib/peaksLod'

type PeaksThis = LibraryState

/** One item's decoded waveform data, carried across a catalogue rebuild. */
interface PreservedItemPeaks {
  peaks: Float32Array
  peaksPerSecond?: number
  sampleRate: number
  peaksLod?: PeaksLodLayer[]
  channelPeaks?: ItemChannelPeaks
}

/** Opaque handle from {@link peaksActions.capturePeaksCache}. */
export type PreservedPeaksCache = ReadonlyMap<string, PreservedItemPeaks>

/** Cache key: peaks only carry over when the item id AND its file both match. */
function preservedKey(itemId: string, filePath: string): string {
  return `${itemId}|${filePathKey(filePath)}`
}

export const peaksActions = {
    /**
     * Snapshot every item's decoded peaks + LOD pyramids before a catalogue
     * rebuild that is known not to change the underlying audio (undo/redo).
     * Restoring these avoids re-reading and re-decoding whole audio files on the
     * main thread — see {@link peaksActions.restorePeaksCache}.
     */
    capturePeaksCache(): PreservedPeaksCache {
      const cache = new Map<string, PreservedItemPeaks>()
      for (const item of this.items) {
        if (item.peaks.length === 0) continue
        cache.set(preservedKey(item.id, item.filePath), {
          peaks: item.peaks,
          peaksPerSecond: item.peaksPerSecond,
          sampleRate: item.sampleRate,
          peaksLod: item.peaksLod,
          channelPeaks: this.channelPeaksByItemId[item.id]
        })
      }
      return cache
    },

    /**
     * Re-attach captured peaks to rebuilt rows that came back with the same id and
     * file. Assigns directly rather than going through `setItemPeaks` so the LOD
     * pyramids are reused as-is instead of being rebuilt. Rows that already hold
     * peaks (a concurrent WAVEFORM_READY landed first) are left untouched.
     */
    restorePeaksCache(cache: PreservedPeaksCache): void {
      let restored = 0
      for (const item of this.items) {
        if (item.peaks.length > 0) continue
        const preserved = cache.get(preservedKey(item.id, item.filePath))
        if (!preserved) continue
        item.peaks = preserved.peaks
        if (preserved.peaksPerSecond !== undefined) item.peaksPerSecond = preserved.peaksPerSecond
        if (item.sampleRate <= 0 && preserved.sampleRate > 0) item.sampleRate = preserved.sampleRate
        item.peaksLod = preserved.peaksLod
        if (preserved.channelPeaks) this.channelPeaksByItemId[item.id] = preserved.channelPeaks
        ++restored
      }
      if (restored > 0) log.debug('library', `restorePeaksCache items=${restored}`)
    },

    /** Replaces peaks for PROJECT_STATE items once cached WAVEFORM_DATA arrives. */
    setItemPeaks(itemId: string, peaks: Float32Array, sampleRate: number, peaksPerSecond?: number): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      // Clips of the same source all deliver that item's identical peaks; once we hold an
      // equivalent set (same length + peaks-per-second) skip the redundant re-store + LOD rebuild.
      if (
        item.peaks &&
        item.peaks.length === peaks.length &&
        item.peaksPerSecond &&
        (peaksPerSecond === undefined || peaksPerSecond === item.peaksPerSecond)
      ) {
        return
      }
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
      // Avoid rebuilding identical shared LOD pyramids for every clip waveform event. Clips that
      // share a source all deliver that item's full peaks (freshly parsed each time, so the arrays
      // are never reference-equal), so dedupe on shape: same channel count + per-channel length +
      // peaks-per-second means the same source peaks and an already-built LOD to reuse. On a
      // multi-clip load this collapses dozens of redundant pyramid builds down to one per source.
      const existing = this.channelPeaksByItemId[itemId]
      if (
        existing &&
        existing.peaksPerSecond === peaksPerSecond &&
        existing.channels.length === channels.length &&
        existing.channels.every((ch, i) => ch.length === channels[i]?.length)
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
