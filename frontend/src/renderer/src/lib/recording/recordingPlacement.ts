// Where a committed recording lands on the timeline (ADR 0030).
//
// A recording belongs to no track while it is being made, so the destination is
// resolved at commit time. It joins the selected track only when that track is
// completely empty; anything already arranged there would otherwise end up buried
// under a clip the performer never asked to stack. Otherwise the recording gets a
// track of its own, scrolled into view so it is never created below the fold.

import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'

/** The track a timeline commit will use, and whether it had to be created. */
export interface RecordingDestination {
  trackId: string
  created: boolean
}

/** Resolves — creating one if needed — the track a timeline commit should use. */
export function resolveRecordingTrackId(): RecordingDestination {
  const project = useProjectStore()
  const selectedId = project.selectedTrackId
  const selected = selectedId ? project.tracks.find((track) => track.id === selectedId) : undefined
  if (selected && selected.clipIds.length === 0) {
    // An existing row can be scrolled out of sight; addTrack() reveals its own.
    useUiStore().requestRevealTrack(selected.id)
    return { trackId: selected.id, created: false }
  }
  return { trackId: project.addTrack(), created: true }
}

/**
 * Undo the destination when the commit it was made for failed. The track is only
 * dropped if it is still the empty one we just added, so a failed save never
 * leaves a stray row behind and never touches a track the user has since used.
 */
export function releaseRecordingTrack(destination: RecordingDestination): void {
  if (!destination.created) return
  const project = useProjectStore()
  const track = project.tracks.find((candidate) => candidate.id === destination.trackId)
  if (track && track.clipIds.length === 0) project.removeTrack(destination.trackId)
}
