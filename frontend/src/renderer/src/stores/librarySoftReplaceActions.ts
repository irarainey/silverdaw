// Library carry-over across an undo/redo soft-replace snapshot.
//
// A soft replace wipes and rehydrates the whole catalogue (`applyProjectStructureReset`
// -> `clear()`), which throws away everything the rows had already resolved: decoded
// peaks, LOD pyramids, parsed tags, and cover-art Blob URLs. None of that can change
// across an undo — the audio files and the project media store are untouched — so
// rehydration re-earns it all at real cost:
//
//   - any item whose file is NOT placed on the timeline misses the backend `.peaks`
//     cache and falls back to `readAudioFile` + `decodeAudioData` on the main thread;
//   - every source/sample/stem row re-reads its tags and re-decodes its cover image
//     over IPC.
//
// Capturing before the wipe and re-attaching afterwards removes both. Spread into the
// library store; `this` is the store instance.

import { log } from '@/lib/log'
import { revokeItemCoverArt } from './libraryItemHelpers'
import { filePathKey } from './projectHelpers'
import type { ItemChannelPeaks, LibraryItem, LibraryState } from './libraryTypes'
import type { PeaksLodLayer } from '@/lib/peaksLod'

type SoftReplaceThis = LibraryState

/** One item's resolved-but-recomputable data, held across a catalogue rebuild. */
interface CarriedItem {
  peaks?: Float32Array
  peaksPerSecond?: number
  sampleRate: number
  peaksLod?: PeaksLodLayer[]
  channelPeaks?: ItemChannelPeaks
  /** Present only when the row had already resolved its tags. */
  metadata?: LibraryItem['metadata']
  coverArtUrl?: string
  hasMedia: boolean
}

/** Opaque handle returned by `captureSoftReplaceCache`. */
export interface SoftReplaceCache {
  readonly items: ReadonlyMap<string, CarriedItem>
  /** Ids whose tags + cover were re-attached, so their media refresh can be skipped. */
  readonly restoredMediaIds: Set<string>
}

/** Carry-over key: data is reused only when the item id AND its file both match. */
function carriedKey(itemId: string, filePath: string): string {
  return `${itemId}|${filePathKey(filePath)}`
}

export const softReplaceActions = {
    /**
     * Snapshot resolved item data immediately before a soft-replace wipe.
     *
     * Cover-art Blob URLs are *moved* into the cache (cleared on the live row) so the
     * imminent `clear()` cannot revoke a URL we intend to reuse. `restoreSoftReplaceCache`
     * therefore owns every captured URL and must revoke any it does not re-attach.
     */
    captureSoftReplaceCache(): SoftReplaceCache {
      const items = new Map<string, CarriedItem>()
      for (const item of this.items) {
        const hasPeaks = item.peaks.length > 0
        const hasMedia = item.metadata !== undefined || item.coverArtUrl !== undefined
        if (!hasPeaks && !hasMedia) continue
        items.set(carriedKey(item.id, item.filePath), {
          peaks: hasPeaks ? item.peaks : undefined,
          peaksPerSecond: item.peaksPerSecond,
          sampleRate: item.sampleRate,
          peaksLod: hasPeaks ? item.peaksLod : undefined,
          channelPeaks: hasPeaks ? this.channelPeaksByItemId[item.id] : undefined,
          metadata: item.metadata,
          coverArtUrl: item.coverArtUrl,
          hasMedia
        })
        // Hand the Blob URL to the cache so `clear()` leaves it alone.
        item.coverArtUrl = undefined
      }
      return { items, restoredMediaIds: new Set<string>() }
    },

    /**
     * Re-attach carried data to rebuilt rows matching on id and file.
     *
     * Peaks are assigned directly rather than through `setItemPeaks` so the LOD pyramids
     * are reused as-is instead of rebuilt. Rows that already resolved their own data (a
     * concurrent WAVEFORM_READY landed first) win and are left untouched. Any cover URL
     * that finds no home is revoked here, since capture took ownership of it.
     */
    restoreSoftReplaceCache(cache: SoftReplaceCache): void {
      let peaksRestored = 0
      const claimedCoverUrls = new Set<string>()
      for (const item of this.items) {
        const carried = cache.items.get(carriedKey(item.id, item.filePath))
        if (!carried) continue
        if (carried.peaks && item.peaks.length === 0) {
          item.peaks = carried.peaks
          if (carried.peaksPerSecond !== undefined) item.peaksPerSecond = carried.peaksPerSecond
          if (item.sampleRate <= 0 && carried.sampleRate > 0) item.sampleRate = carried.sampleRate
          item.peaksLod = carried.peaksLod
          if (carried.channelPeaks) this.channelPeaksByItemId[item.id] = carried.channelPeaks
          ++peaksRestored
        }
        if (carried.hasMedia && item.metadata === undefined && item.coverArtUrl === undefined) {
          item.metadata = carried.metadata
          item.coverArtUrl = carried.coverArtUrl
          if (carried.coverArtUrl) claimedCoverUrls.add(carried.coverArtUrl)
          cache.restoredMediaIds.add(item.id)
        }
      }
      // Capture took ownership of every cover URL; release the ones nothing claimed.
      // A single Blob URL can be shared by a source and its stems, so only revoke a
      // URL that no restored row ended up pointing at.
      for (const carried of cache.items.values()) {
        if (!carried.coverArtUrl || claimedCoverUrls.has(carried.coverArtUrl)) continue
        revokeItemCoverArt({ coverArtUrl: carried.coverArtUrl } as LibraryItem)
      }
      if (peaksRestored > 0 || cache.restoredMediaIds.size > 0) {
        log.debug(
          'library',
          `restoreSoftReplaceCache peaks=${peaksRestored} media=${cache.restoredMediaIds.size}`
        )
      }
    },
} satisfies Record<string, (this: SoftReplaceThis, ...args: never[]) => unknown> &
  ThisType<SoftReplaceThis>
