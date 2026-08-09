// Transport navigation (play / pause + skip-back / skip-forward) for the
// transport bar, extracted from TransportBar.vue. Skip honours the user's
// "skip button target" preference: either timeline ends (rewind to 0 / seek to
// project end) or the nearest project marker. UI state is flipped
// optimistically; the backend's PLAYHEAD_UPDATE is the source of truth.
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { usePreviewStore } from '@/stores/previewStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'

export interface TransportSkip {
  onSkipBack: () => void
  onPlay: () => void
  onSkipForward: () => void
}

// Play/pause is shared by the transport bar, the Space shortcut and MIDI, so it
// takes optional store handles: callers that already hold their own (the
// keyboard composable injects them for testing) pass them in rather than
// resolving a second set from Pinia.
export interface TransportPlaybackStores {
  project: ReturnType<typeof useProjectStore>
  transport: ReturnType<typeof useTransportStore>
  ui: ReturnType<typeof useUiStore>
  preview: ReturnType<typeof usePreviewStore>
}

// Everything the marker-stepping lookups need, so they stay pure and usable
// from callers that hold their own store handles.
export interface MarkerSeekContext {
  positionMs: number
  markers: readonly { positionMs: number }[]
  selectionStartMs: number | null
}

// Markers sit on whole-millisecond positions but the playhead is a float, so
// we exclude any marker within this slop of the current position to stop a
// button press snapping back onto the marker we're parked on.
const MARKER_SKIP_EPSILON_MS = 1

// The engine quantises every seek to a whole sample and reports that value back via
// PLAYHEAD_UPDATE, so a playhead parked exactly where we asked still reads back up to
// half a sample out (~0.011 ms at 44.1 kHz). Anything within this slop counts as
// "already there", which is far below both the snap grid and audibility.
const SEEK_REDUNDANT_EPSILON_MS = 0.05

// Nearest marker strictly before the playhead, or null when there is none. The
// start of an active timeline selection counts as a temporary marker so every
// marker-stepping affordance (buttons, MIDI cue, Ctrl+Arrow) agrees on targets.
// Pure so callers that own their own store handles can reuse it.
export function previousMarkerCandidateMs(context: MarkerSeekContext): number | null {
  const { positionMs, markers, selectionStartMs } = context
  let target: number | null = null
  if (selectionStartMs !== null && selectionStartMs < positionMs - MARKER_SKIP_EPSILON_MS) {
    target = selectionStartMs
  }
  for (const marker of markers) {
    if (
      marker.positionMs < positionMs - MARKER_SKIP_EPSILON_MS &&
      (target === null || marker.positionMs > target)
    ) {
      target = marker.positionMs
    }
  }
  return target
}

// Nearest marker strictly after the playhead, or null when there is none.
export function nextMarkerCandidateMs(context: MarkerSeekContext): number | null {
  const { positionMs, markers, selectionStartMs } = context
  let target: number | null = null
  if (selectionStartMs !== null && selectionStartMs > positionMs + MARKER_SKIP_EPSILON_MS) {
    target = selectionStartMs
  }
  for (const marker of markers) {
    if (
      marker.positionMs > positionMs + MARKER_SKIP_EPSILON_MS &&
      (target === null || marker.positionMs < target)
    ) {
      target = marker.positionMs
    }
  }
  return target
}

function markerSeekContext(): MarkerSeekContext {
  const selection = useUiStore().timelineSelection
  return {
    positionMs: useTransportStore().positionMs,
    markers: useProjectStore().markers,
    selectionStartMs: selection ? selection.startMs : null
  }
}

// Skip-button targets: as above, but falling back to the timeline start / end
// once there is nothing left to step to.
function previousMarkerMs(): number {
  return previousMarkerCandidateMs(markerSeekContext()) ?? 0
}

function nextMarkerMs(): number | null {
  const target = nextMarkerCandidateMs(markerSeekContext())
  if (target !== null) return target
  const pos = useTransportStore().positionMs
  const end = useProjectStore().durationMs
  return Number.isFinite(end) && end > pos + MARKER_SKIP_EPSILON_MS ? end : null
}

function seekToSkipTarget(positionMs: number): void {
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  transport.setPosition(positionMs)
  sendBridge('TRANSPORT_SEEK', { positionMs })
  if (positionMs <= 0) {
    project.viewScrollX = 0
    sendBridge('PROJECT_SET_VIEW', { scrollX: 0 })
  } else {
    ui.requestTimelineScrollToPosition(positionMs)
  }
}

export function seekToPreviousMarker(source = 'click skip-back'): void {
  const target = previousMarkerMs()
  log.info('transport', `${source} -> previous marker ${target}ms`)
  seekToSkipTarget(target)
}

export function seekToNextMarker(source = 'click skip-forward'): void {
  const target = nextMarkerMs()
  if (target === null) return
  log.info('transport', `${source} -> next marker ${target}ms`)
  seekToSkipTarget(target)
}

export function seekToMarkerIndex(index: number, source = 'marker shortcut'): void {
  const marker = useProjectStore().markers[index]
  if (!marker) return
  log.info('transport', `${source} -> marker ${index + 1} at ${marker.positionMs}ms`)
  seekToSkipTarget(marker.positionMs)
}

export function toggleTransportPlayback(source = 'click', stores?: TransportPlaybackStores): void {
  const project = stores?.project ?? useProjectStore()
  const transport = stores?.transport ?? useTransportStore()
  const ui = stores?.ui ?? useUiStore()
  const preview = stores?.preview ?? usePreviewStore()
  if (!transport.isPlaying && transport.audioState !== 'ready') {
    log.info('transport', `${source} play ignored (audio output unavailable)`)
    return
  }
  // One thing plays at a time: an active preview audition owns the output, so
  // starting project playback is blocked until it stops. Pausing stays allowed
  // so the transport can never be left stuck playing.
  if (!transport.isPlaying && preview.isPlaying) {
    log.info('transport', `${source} play ignored (preview is playing)`)
    return
  }
  if (transport.midiPlaybackHoldActive) {
    if (transport.isPlaying) {
      log.info('transport', `${source} pause while MIDI playback is held`)
      transport.setPlaybackState(false)
      return
    }
    const end = project.durationMs
    if (end > 0 && transport.positionMs >= end) {
      log.info('transport', `${source} play ignored (at end of project)`)
      return
    }
    log.info('transport', `${source} play armed while MIDI playback is held`)
    transport.setPlaybackState(true)
    return
  }
  if (transport.isPlaying) {
    log.info('transport', `${source} pause`)
    sendBridge('TRANSPORT_PAUSE')
    transport.setPlaybackState(false)
    return
  }

  const selection = ui.timelineSelection
  if (selection) {
    log.info(
      'transport',
      `${source} ${ui.loopTimelineSelection ? 'loop selection' : 'play selection'} ` +
      `${selection.startMs}..${selection.endMs}ms`
    )
    // Captured before setPosition below overwrites the store's mirror of the engine position.
    const alreadyAtStart =
      Math.abs(transport.positionMs - selection.startMs) <= SEEK_REDUNDANT_EPSILON_MS
    transport.setPosition(selection.startMs)
    ui.requestTimelineScrollToPosition(selection.startMs, true)
    // Only seek when the playhead is not already on the range start. Finishing a range
    // drag already parks it there, and a seek is far from free: the engine flags every
    // track's read-ahead dirty, so the settle that follows recreates each
    // BufferingAudioSource and refills it from disk. Done here, that warm-up is thrown
    // away and redone inline by the play that follows in the same tick — play() cancels
    // the pending prewarm, then rebuilds and blocks the message thread waiting for the
    // refill. That is a stall on the first beat, and how long it lasts depends on how
    // quickly the machine schedules the buffering thread and serves the reads, so it can
    // show on one machine and not another of the same spec.
    if (!alreadyAtStart) {
      sendBridge('TRANSPORT_SEEK', { positionMs: selection.startMs })
    }
    sendBridge('TRANSPORT_PLAY')
    transport.setPlaybackState(true)
    return
  }

  const end = project.durationMs
  if (end > 0 && transport.positionMs >= end) {
    log.info('transport', `${source} play ignored (at end of project)`)
    return
  }
  log.info('transport', `${source} play`)
  sendBridge('TRANSPORT_PLAY')
  transport.setPlaybackState(true)
}

export function useTransportSkip(): TransportSkip {
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()

  function onSkipBack(): void {
    // Skip-back never changes the playback state — if playback was running,
    // it just carries on from the new position.
    if (ui.skipButtonTarget === 'markers') {
      seekToPreviousMarker()
      return
    }
    const selectionStartMs = ui.timelineSelection?.startMs
    if (
      selectionStartMs !== undefined &&
      selectionStartMs < transport.positionMs - MARKER_SKIP_EPSILON_MS
    ) {
      log.info('transport', `click skip-back -> selection start ${selectionStartMs}ms`)
      seekToSkipTarget(selectionStartMs)
      return
    }
    // Default: rewind to the start of the timeline and scroll the view there.
    log.info('transport', 'click skip-back')
    project.viewScrollX = 0
    sendBridge('PROJECT_SET_VIEW', { scrollX: 0 })
    transport.setPosition(0)
    sendBridge('TRANSPORT_SEEK', { positionMs: 0 })
  }

  function onPlay(): void {
    toggleTransportPlayback()
  }

  function onSkipForward(): void {
    // Seek to the end of the project — the union of every track's length
    // and every clip's end time. Mirrors the existing back/stop semantics:
    // we send the seek and let the backend's PLAYHEAD_UPDATE confirm.
    if (ui.skipButtonTarget === 'markers') {
      seekToNextMarker()
      return
    }
    const selectionStartMs = ui.timelineSelection?.startMs
    if (
      selectionStartMs !== undefined &&
      selectionStartMs > transport.positionMs + MARKER_SKIP_EPSILON_MS
    ) {
      log.info('transport', `click skip-forward -> selection start ${selectionStartMs}ms`)
      seekToSkipTarget(selectionStartMs)
      return
    }
    const end = project.durationMs
    if (!Number.isFinite(end) || end <= 0) return
    log.info('transport', `click skip-forward -> ${end}ms`)
    sendBridge('TRANSPORT_SEEK', { positionMs: end })
    // Mirror skip-back's rewind-and-scroll: bring the timeline view to the end
    // so the playhead's new resting place is on screen.
    ui.requestTimelineScroll('end')
  }

  return { onSkipBack, onPlay, onSkipForward }
}
