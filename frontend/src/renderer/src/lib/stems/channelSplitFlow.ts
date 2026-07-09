// Renderer-side lifecycle for the "split stereo channels" feature. A single
// reactive ref drives a small picker dialog (which channels — Left / Right — to
// extract). On confirm it registers the placement job and dispatches
// CLIP_SPLIT_CHANNELS; the running job's result is handled by the bridge handler
// (createTracksFromChannelSplit). No progress dialog: the export is a fast
// file-write, so a toast on start/finish is enough.

import { ref, readonly, type Ref } from 'vue'
import { send as sendBridge } from '@/lib/bridgeService'
import { registerChannelSplitJob, type ChannelSplitTarget, type SplitChannel } from '@/lib/stems/createChannelSplitTracks'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'

/** Canonical channel order; the picker and dispatch use it. */
const ALL_CHANNELS: readonly SplitChannel[] = ['left', 'right']

export interface ChannelSplitSelectionState {
  target: ChannelSplitTarget
  /** Which channels are ticked; at least one is required to start. */
  selected: Record<SplitChannel, boolean>
}

const selection: Ref<ChannelSplitSelectionState | null> = ref(null)

export function useChannelSplitSelection(): Readonly<Ref<ChannelSplitSelectionState | null>> {
  return readonly(selection)
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * Entry from the clip context menu: open the channel picker for a stereo clip.
 * No-op (with a notice) when the clip's source isn't stereo — the menu item is
 * hidden in that case, so this is a defensive guard.
 */
export function requestChannelSplitForClip(clipId: string): void {
  const project = useProjectStore()
  const library = useLibraryStore()
  const clip = project.clips[clipId]
  if (!clip) return
  const sourceItemId = clip.libraryItemId
  if (!sourceItemId) return
  const sourceItem = library.byId[sourceItemId]
  if (!sourceItem || sourceItem.channelCount !== 2) {
    useNotificationsStore().pushInfo('This clip isn’t stereo, so there are no channels to split.')
    return
  }
  const name = libraryItemDisplayName(sourceItem)
  selection.value = {
    target: {
      sourceItemId,
      sourceName: stripExtension(name),
      clipId,
      startMs: clip.startMs,
      sourceInMs: clip.inMs
    },
    // Default to nothing ticked (Split stays disabled until a channel is chosen),
    // matching the Separate Stems dialog so both pickers behave the same way.
    selected: { left: false, right: false }
  }
}

/** Toggle one channel in the picker. */
export function toggleChannelSelection(channel: SplitChannel): void {
  if (!selection.value) return
  selection.value = {
    ...selection.value,
    selected: { ...selection.value.selected, [channel]: !selection.value.selected[channel] }
  }
}

/** Dismiss the picker without starting anything. */
export function cancelChannelSplit(): void {
  selection.value = null
}

/** Start: dispatch the split for the ticked channels. No-op when none are ticked
 *  (the dialog disables Start in that case too). */
export function confirmChannelSplit(): void {
  const current = selection.value
  if (!current) return
  const channels = ALL_CHANNELS.filter((c) => current.selected[c])
  if (channels.length === 0) return
  selection.value = null

  const jobId = crypto.randomUUID()
  registerChannelSplitJob(jobId, current.target)
  sendBridge('CLIP_SPLIT_CHANNELS', {
    jobId,
    clipId: current.target.clipId,
    sourceName: current.target.sourceName,
    channels
  })
  useNotificationsStore().pushInfo(
    `Splitting ${channels.length === 1 ? 'channel' : 'channels'} from ${current.target.sourceName}…`
  )
  log.info('channels', `split jobId=${jobId} clip=${current.target.clipId} channels=${channels.join(',')}`)
}
