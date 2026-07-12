// Turns a completed channel split into stem-kind library items and timeline tracks.
// Mirrors createStemTracks: each channel WAV is imported through the shared
// library-import flow (single source of truth), inherits the source's analysis, and
// lands on its own new track aligned to the source clip's start — so a split channel
// behaves exactly like a stem (inherits the grid, auto-warps on placement).

import { importAudioIntoLibrary, libraryItemToClipPlacement } from '@/lib/importAudio'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { STEM_NAME_SEPARATOR } from '@/stores/libraryItemHelpers'
import { inheritSourceAnalysis } from '@/lib/library/inheritSourceAnalysis'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { ChannelSplitReadyPayload } from '@shared/bridge-protocol'

/** Which source channel a split track carries. */
export type SplitChannel = 'left' | 'right'

const CHANNEL_LABEL: Record<SplitChannel, string> = {
  left: 'Left',
  right: 'Right'
}

/** Where a channel split's tracks go. The renderer owns this so the bridge
 *  envelope stays minimal and placement never depends on echoed fields. */
export interface ChannelSplitTarget {
  /** Source library item the channels derive from (the split clip's own item). */
  sourceItemId: string
  /** Friendly source name for the track/library names. */
  sourceName: string
  /** The split clip; each channel lands on a new track aligned to it. */
  clipId: string
  /** Start of the source clip (ms) used to align placed channel clips. */
  startMs: number
  /** The source clip's trim-in (ms); the channel WAV's sample 0 is source-time
   *  `inMs`, so the inherited beat grid is shifted back by this. */
  sourceInMs: number
}

interface ChannelSplitJob {
  target: ChannelSplitTarget
  /** Channels imported (or in flight) so a channel is never placed twice. */
  placed: Set<SplitChannel>
}

const jobs = new Map<string, ChannelSplitJob>()

/** Record where a job's channels should go before the result arrives. Called by
 *  the flow right after CLIP_SPLIT_CHANNELS is dispatched. */
export function registerChannelSplitJob(jobId: string, target: ChannelSplitTarget): void {
  jobs.set(jobId, { target, placed: new Set<SplitChannel>() })
}

/** Forget a job's placement state without placing anything (e.g. on failure). */
export function forgetChannelSplitJob(jobId: string): void {
  jobs.delete(jobId)
}

/** Import one channel WAV into the library and place it on a new track. Reserves
 *  the channel synchronously (before the first await) so duplicate events are
 *  skipped; un-reserves on failure so a later event can retry. */
async function importChannel(job: ChannelSplitJob, channel: SplitChannel, filePath: string): Promise<boolean> {
  if (job.placed.has(channel)) return false
  job.placed.add(channel)

  const library = useLibraryStore()
  // The caller reserved one batch slot per channel. `importAudioIntoLibrary` notes
  // its own completion, so balance the slot ourselves only when we bail out early.
  let delegatedImport = false
  try {
    const project = useProjectStore()
    const { target } = job
    const sourceItem = library.getItem(target.sourceItemId)

    const opened = await window.silverdaw.readAudioFile(filePath)
    if (!opened) {
      log.error('channels', `could not read channel file ${filePath}`)
      job.placed.delete(channel)
      return false
    }
    const label = CHANNEL_LABEL[channel]
    const displayName = `${label} ${STEM_NAME_SEPARATOR} ${target.sourceName}`
    delegatedImport = true
    // A channel split is a stem in every respect except how it was produced, so it
    // reuses the 'stem' kind (badge, cleanup, serialization) with no new surface.
    const itemId = await importAudioIntoLibrary(opened, {
      kind: 'stem',
      name: displayName,
      derivedFrom: {
        sourceItemId: target.sourceItemId,
        sourceClipId: target.clipId,
        inMs: target.sourceInMs,
        durationMs: 0
      }
    })
    if (!itemId) {
      job.placed.delete(channel)
      return false
    }
    // Sample-aligned with the source, so reuse its analysis (instant + accurate,
    // resolves any pending auto-warp). The window starts at source-time inMs.
    inheritSourceAnalysis(library, itemId, sourceItem, target.sourceInMs / 1000)
    const audio = library.getItem(itemId)
    if (!audio) {
      job.placed.delete(channel)
      return false
    }

    // New track, its name, and the channel clip placement are ONE undo step.
    runInUndoGroup(`Add ${label} channel`, () => {
      const trackId = project.addTrack()
      project.setTrackName(trackId, displayName)
      project.addClipFromLibrary(trackId, libraryItemToClipPlacement(audio), target.startMs)
    })
    return true
  } catch (err) {
    log.error(
      'channels',
      `failed to import channel ${channel}: ${err instanceof Error ? err.message : String(err)}`
    )
    job.placed.delete(channel)
    return false
  } finally {
    if (!delegatedImport) library.noteImportFinished()
  }
}

/** Import every produced channel and place each on its own new track, then report
 *  the summary and forget the job. */
export async function createTracksFromChannelSplit(payload: ChannelSplitReadyPayload): Promise<void> {
  const job = jobs.get(payload.jobId)
  if (!job) return
  const library = useLibraryStore()
  const notifications = useNotificationsStore()

  const pending = payload.channels.filter((c) => !job.placed.has(c.channel))
  if (pending.length > 0) library.beginImportBatch(pending.length)
  for (const { channel, filePath } of pending) {
    await importChannel(job, channel, filePath)
  }

  const created = job.placed.size
  const sourceName = job.target.sourceName
  jobs.delete(payload.jobId)
  if (created > 0) {
    notifications.pushInfo(
      `Added ${created} channel ${created === 1 ? 'track' : 'tracks'} from ${sourceName}`
    )
  } else {
    notifications.pushError(`Could not split channels from ${sourceName}`)
  }
}
