// Transport navigation (play / pause + skip-back / skip-forward) for the
// transport bar, extracted from TransportBar.vue. Skip honours the user's
// "skip button target" preference: either timeline ends (rewind to 0 / seek to
// project end) or the nearest project marker. UI state is flipped
// optimistically; the backend's PLAYHEAD_UPDATE is the source of truth.
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'

export interface TransportSkip {
  onSkipBack: () => void
  onPlay: () => void
  onSkipForward: () => void
}

// Markers sit on whole-millisecond positions but the playhead is a float, so
// we exclude any marker within this slop of the current position to stop a
// button press snapping back onto the marker we're parked on.
const MARKER_SKIP_EPSILON_MS = 1

export function useTransportSkip(): TransportSkip {
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()

  /** Nearest marker strictly before the playhead, or 0 (project start) when
   *  there's none. */
  function previousMarkerMs(): number {
    const pos = transport.positionMs
    let target = 0
    for (const marker of project.markers) {
      if (marker.positionMs < pos - MARKER_SKIP_EPSILON_MS && marker.positionMs > target) {
        target = marker.positionMs
      }
    }
    return target
  }

  /** Nearest marker strictly after the playhead, falling back to the end of
   *  the project. Returns null when there's nowhere valid to seek. */
  function nextMarkerMs(): number | null {
    const pos = transport.positionMs
    let target = Number.POSITIVE_INFINITY
    for (const marker of project.markers) {
      if (marker.positionMs > pos + MARKER_SKIP_EPSILON_MS && marker.positionMs < target) {
        target = marker.positionMs
      }
    }
    if (Number.isFinite(target)) return target
    const end = project.durationMs
    return Number.isFinite(end) && end > pos + MARKER_SKIP_EPSILON_MS ? end : null
  }

  /** Seek to a marker-mode target: move the playhead and bring it into view
   *  without changing the playback state. */
  function seekToSkipTarget(positionMs: number): void {
    transport.setPosition(positionMs)
    sendBridge('TRANSPORT_SEEK', { positionMs })
    if (positionMs <= 0) {
      project.viewScrollX = 0
      sendBridge('PROJECT_SET_VIEW', { scrollX: 0 })
    } else {
      ui.requestTimelineScrollToPosition(positionMs)
    }
  }

  function onSkipBack(): void {
    // Skip-back never changes the playback state — if playback was running,
    // it just carries on from the new position.
    if (ui.skipButtonTarget === 'markers') {
      const target = previousMarkerMs()
      log.info('transport', `click skip-back -> prev marker ${target}ms`)
      seekToSkipTarget(target)
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
    // Optimistically flip the UI state; the backend's PLAYHEAD_UPDATE will
    // overwrite this within ~16 ms either way.
    if (transport.isPlaying) {
      log.info('transport', 'click pause')
      sendBridge('TRANSPORT_PAUSE')
      transport.setPlaybackState(false)
    } else {
      // Playhead parked at (or past) the end of the project — Play is a
      // no-op. The button itself is disabled in this case (see
      // `playDisabled`); this guard also catches the keyboard-shortcut
      // path so Spacebar can't sneak past the UI.
      const end = project.durationMs
      if (end > 0 && transport.positionMs >= end) {
        log.info('transport', 'click play ignored (at end of project)')
        return
      }
      log.info('transport', 'click play')
      sendBridge('TRANSPORT_PLAY')
      transport.setPlaybackState(true)
    }
  }

  function onSkipForward(): void {
    // Seek to the end of the project — the union of every track's length
    // and every clip's end time. Mirrors the existing back/stop semantics:
    // we send the seek and let the backend's PLAYHEAD_UPDATE confirm.
    if (ui.skipButtonTarget === 'markers') {
      const target = nextMarkerMs()
      if (target === null) return
      log.info('transport', `click skip-forward -> next marker ${target}ms`)
      seekToSkipTarget(target)
      return
    }
    const end = project.durationMs
    if (!Number.isFinite(end) || end <= 0) return
    log.info('transport', `click skip-forward -> ${end}ms`)
    sendBridge('TRANSPORT_SEEK', { positionMs: end })
  }

  return { onSkipBack, onPlay, onSkipForward }
}
