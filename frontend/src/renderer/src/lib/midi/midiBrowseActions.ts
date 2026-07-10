import { useProjectStore } from '@/stores/projectStore'
import type { Clip } from '@/stores/projectTypes'
import { useUiStore } from '@/stores/uiStore'

interface ClipBrowseState {
  trackId: string
  cursorClipId: string
}

const clipBrowseByDevice = new Map<string, ClipBrowseState>()

function orderedTrackClips(trackId: string): Clip[] {
  const project = useProjectStore()
  const track = project.tracks.find((candidate) => candidate.id === trackId)
  if (!track) return []
  return track.clipIds
    .map((clipId) => project.clips[clipId])
    .filter((clip): clip is Clip => clip !== undefined)
    .sort((a, b) => a.startMs - b.startMs)
}

function revealClip(clip: Clip): void {
  useUiStore().requestTimelineScrollToPosition(clip.startMs)
}

function browseTracks(delta: number): void {
  const project = useProjectStore()
  const ui = useUiStore()
  if (project.tracks.length === 0 || delta === 0) return

  const selectedIndex = project.tracks.findIndex((track) => track.id === project.selectedTrackId)
  if (selectedIndex < 0) {
    const firstTrack = project.tracks[0]
    if (!firstTrack) return
    project.selectTrack(firstTrack.id)
    ui.requestRevealTrack(firstTrack.id)
    return
  }
  const nextIndex = Math.max(
    0,
    Math.min(project.tracks.length - 1, selectedIndex + Math.sign(delta))
  )
  const nextTrack = project.tracks[nextIndex]
  if (!nextTrack || nextTrack.id === project.selectedTrackId) return
  project.selectTrack(nextTrack.id)
  ui.requestRevealTrack(nextTrack.id)
}

function activeClipState(deviceIdentifier: string): ClipBrowseState | null {
  const state = clipBrowseByDevice.get(deviceIdentifier)
  if (!state) return null
  const project = useProjectStore()
  if (project.selectedTrackId !== state.trackId || !project.clips[state.cursorClipId]) {
    clipBrowseByDevice.delete(deviceIdentifier)
    return null
  }
  return state
}

function browseClips(state: ClipBrowseState, delta: number, extendSelection: boolean): void {
  if (delta === 0) return
  const clips = orderedTrackClips(state.trackId)
  const currentIndex = clips.findIndex((clip) => clip.id === state.cursorClipId)
  if (currentIndex < 0) return
  const nextIndex = Math.max(0, Math.min(clips.length - 1, currentIndex + Math.sign(delta)))
  const nextClip = clips[nextIndex]
  if (!nextClip || nextClip.id === state.cursorClipId) return

  state.cursorClipId = nextClip.id
  const project = useProjectStore()
  if (extendSelection) project.selectClipRange(nextClip.id)
  else project.selectClip(nextClip.id)
  revealClip(nextClip)
}

/** Returns false only when shifted rotation should retain its track-mode zoom action. */
export function handleBrowseRotation(
  deviceIdentifier: string,
  delta: number,
  extendSelection: boolean
): boolean {
  const state = activeClipState(deviceIdentifier)
  if (state) {
    browseClips(state, delta, extendSelection)
    return true
  }
  if (extendSelection) return false
  browseTracks(delta)
  return true
}

export function handleBrowsePress(deviceIdentifier: string): void {
  const project = useProjectStore()
  const ui = useUiStore()
  const state = activeClipState(deviceIdentifier)
  if (state) {
    clipBrowseByDevice.delete(deviceIdentifier)
    project.clearClipSelection()
    project.selectTrack(state.trackId)
    ui.requestRevealTrack(state.trackId)
    return
  }

  const trackId = project.selectedTrackId
  if (!trackId) return
  const firstClip = orderedTrackClips(trackId)[0]
  if (!firstClip) return
  project.selectClip(firstClip.id)
  clipBrowseByDevice.set(deviceIdentifier, { trackId, cursorClipId: firstClip.id })
  revealClip(firstClip)
}

export function resetMidiBrowseActionsForTests(): void {
  clipBrowseByDevice.clear()
}
