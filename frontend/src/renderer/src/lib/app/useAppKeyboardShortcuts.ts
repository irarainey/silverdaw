// Global capture-phase keyboard shortcuts for the application shell, extracted
// from App.vue. Owns transport (play/pause, seek), timeline zoom, marker
// add/seek, and clip lock/export shortcuts. Registered by the SFC's onMounted as
// a window capture-phase keydown listener and torn down on unmount; this module
// only provides the handler. Editable-target and modal guards keep shortcuts
// from firing while the user is typing or a dialog owns the keyboard.
import type { useTransportStore } from '@/stores/transportStore'
import type { useProjectStore } from '@/stores/projectStore'
import type { useUiStore } from '@/stores/uiStore'
import type { useLibraryStore } from '@/stores/libraryStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { clipFirstBeatOffsetMs } from '@/lib/clip/clipTiming'
import { AUTOMATION_PARAMS } from '@/lib/automation/automationParams'
import { log } from '@/lib/log'

type TransportStore = ReturnType<typeof useTransportStore>
type ProjectStore = ReturnType<typeof useProjectStore>
type UiStore = ReturnType<typeof useUiStore>
type LibraryStore = ReturnType<typeof useLibraryStore>

export interface AppKeyboardShortcutsDeps {
  transport: TransportStore
  project: ProjectStore
  ui: UiStore
  library: LibraryStore
  // True when a modal/dialog owns the keyboard; shortcuts are suppressed.
  isModalOpen: () => boolean
  // Opens the Export Mixdown dialog (Ctrl/Cmd+M).
  openExportMixdown: () => void
}

export interface AppKeyboardShortcuts {
  onGlobalShortcutKey: (e: KeyboardEvent) => void
}

const SUB_BEATS_PER_BEAT = 4

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    // <input type="range"> sliders (master volume, future faders)
    // should not swallow global shortcuts. Space does nothing on a
    // range — arrows are the proper keyboard interaction — so the
    // global Space=play handler should still fire when a slider
    // happens to hold focus after a drag.
    const type = (target as HTMLInputElement).type
    return type !== 'range'
  }
  return target.isContentEditable
}

export function useAppKeyboardShortcuts(deps: AppKeyboardShortcutsDeps): AppKeyboardShortcuts {
  const { transport, project, ui, library } = deps

  // Tracks the exact last arrow-seek target so repeated presses step off the
  // precise value rather than the backend's sub-ms-rounded ack (see the grid
  // step branch for the rationale).
  let lastArrowSeekMs: number | null = null

  // Resolve the clip a keyboard nudge should act on: the selected, unlocked
  // clip. Returns null (after logging the reason) when there is nothing to move,
  // shared by the Shift+Arrow (grid) and Shift+Alt+Arrow (fine) nudge branches.
  function nudgeTargetClip(
    label: string
  ): { id: string; clip: NonNullable<ProjectStore['clips'][string]> } | null {
    const id = project.selectedClipId
    const clip = id ? project.clips[id] : null
    if (!id || !clip) {
      log.info('project', `${label} ignored — no clip selected`)
      return null
    }
    if (clip.locked) {
      log.info('project', `${label} ignored — clip ${id} locked`)
      return null
    }
    return { id, clip }
  }

  // Jump the playhead to the start of the timeline and scroll the view there.
  // Never touches the playback state — playing carries on from 0. Shared by the
  // Ctrl/Cmd+Shift+ArrowLeft and Home shortcuts.
  function seekToTimelineStart(): void {
    lastArrowSeekMs = null
    ui.requestTimelineScroll('start')
    transport.setPosition(0)
    sendBridge('TRANSPORT_SEEK', { positionMs: 0 })
    log.info('transport', 'shortcut skip-back')
  }

  // Jump the playhead to the end of the timeline and scroll the view there.
  // No-op when the project is empty. Shared by the Ctrl/Cmd+Shift+ArrowRight and
  // End shortcuts.
  function seekToTimelineEnd(): void {
    const end = project.durationMs
    if (!Number.isFinite(end) || end <= 0) return
    lastArrowSeekMs = null
    ui.requestTimelineScroll('end')
    transport.setPosition(end)
    sendBridge('TRANSPORT_SEEK', { positionMs: end })
    log.info('transport', `shortcut skip-forward -> ${end}ms`)
  }

  function onGlobalShortcutKey(e: KeyboardEvent): void {
    // Don't fight text fields, and don't trigger before the bridge is up
    // (no point sending TRANSPORT_SEEK that the backend would just drop).
    if (isEditableTarget(e.target)) return
    if (deps.isModalOpen()) return
    if (!transport.bridgeReady) return
    // Mid-session engine recovery gates all transport/zoom shortcuts behind
    // the overlay until the engine is healthy again.
    if (transport.engineRecovery !== 'ok') return

    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      lastArrowSeekMs = null
      if (transport.isPlaying) {
        sendBridge('TRANSPORT_PAUSE')
        transport.setPlaybackState(false)
        log.info('transport', 'shortcut pause')
      } else {
        // Playhead parked at the end → Spacebar Play is a no-op.
        // Mirrors `TransportBar.onPlay`'s guard so the keyboard
        // shortcut can't bypass the disabled Play button.
        const end = project.durationMs
        if (end > 0 && transport.positionMs >= end) {
          log.info('transport', 'shortcut play ignored (at end of project)')
          return
        }
        sendBridge('TRANSPORT_PLAY')
        transport.setPlaybackState(true)
        log.info('transport', 'shortcut play')
      }
      return
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
      // Toggle lock on the currently-selected clip. Per-clip — siblings
      // of a library-clip instance stay independent.
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      const id = project.selectedClipId
      if (!id) {
        log.info('project', 'shortcut Ctrl+L ignored — no clip selected')
        return
      }
      const clip = project.clips[id]
      if (!clip) return
      project.setClipLocked(id, !clip.locked)
      return
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault()
      e.stopPropagation()
      const hasAnyClip = project.tracks.some((track) => track.clipIds.length > 0)
      if (!hasAnyClip) {
        log.info('mixdown', 'shortcut export ignored — no clips to render')
        return
      }
      deps.openExportMixdown()
      log.info('mixdown', 'shortcut open export dialog')
      return
    }

    // Escape: clear the current clip / track / automation-point selection.
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const hadSelection =
        project.selectedClipId !== null ||
        project.selectedTrackId !== null ||
        ui.selectedAutomationPoint !== null
      if (!hadSelection) return
      e.preventDefault()
      e.stopPropagation()
      project.selectClip(null)
      project.selectTrack(null)
      ui.setSelectedAutomationPoint(null)
      log.debug('project', 'shortcut escape — cleared selection')
      return
    }

    // K: toggle the project metronome.
    if (e.key.toLowerCase() === 'k' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      project.setMetronomeEnabled(!project.metronomeEnabled)
      log.info('transport', `shortcut metronome ${project.metronomeEnabled ? 'on' : 'off'}`)
      return
    }

    // Shift+M / Shift+S: mute / solo the selected track (bare M / S are Marker /
    // Split, so the track-mix twins take Shift).
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
        (e.key.toLowerCase() === 'm' || e.key.toLowerCase() === 's')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      const trackId = project.selectedTrackId
      if (!trackId) {
        log.info('project', 'shortcut mute/solo ignored — no track selected')
        return
      }
      if (e.key.toLowerCase() === 'm') project.toggleMute(trackId)
      else project.toggleSolo(trackId)
      return
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      let zoomAction: 'in' | 'out' | 'reset' | null = null
      if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
        zoomAction = 'in'
      } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
        zoomAction = 'out'
      } else if (e.key === '0' || e.code === 'Numpad0' || e.code === 'Digit0') {
        zoomAction = 'reset'
      }
      if (zoomAction) {
        e.preventDefault()
        e.stopPropagation()
        ui.requestTimelineZoom(zoomAction)
        return
      }
    }

    // Automation point selected: arrows fine-nudge it. Up/Down = value (5% range,
    // Shift = 1%); Left/Right = time (5 ms, Alt = 1 ms). Endpoints keep their time.
    if (ui.selectedAutomationPoint && !e.ctrlKey && !e.metaKey &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      e.stopPropagation()
      const { trackId, paramId, index } = ui.selectedAutomationPoint
      const range = AUTOMATION_PARAMS[paramId].max - AUTOMATION_PARAMS[paramId].min
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const step = range * (e.shiftKey ? 0.01 : 0.05) * (e.key === 'ArrowUp' ? 1 : -1)
        project.nudgeAutomationPoint(trackId, paramId, index, 0, step)
      } else {
        const dt = (e.altKey ? 1 : 5) * (e.key === 'ArrowLeft' ? -1 : 1)
        project.nudgeAutomationPoint(trackId, paramId, index, dt, 0)
      }
      return
    }

    if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      const msPerSub = 60_000 / transport.bpm / SUB_BEATS_PER_BEAT
      const snappedMs = Math.max(0, Math.round(transport.positionMs / msPerSub) * msPerSub)
      project.toggleMarkerAt(snappedMs)
      return
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'ArrowLeft') {
        seekToTimelineStart()
      } else {
        seekToTimelineEnd()
      }
      return
    }

    // Home / End: jump the playhead to the start / end of the timeline (the
    // bare-key twin of Ctrl/Cmd+Shift+Arrow). No modifiers — a modified
    // Home/End is left to the browser / OS.
    if ((e.key === 'Home' || e.key === 'End') && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Home') {
        seekToTimelineStart()
      } else {
        seekToTimelineEnd()
      }
      return
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      e.stopPropagation()
      const direction = e.key === 'ArrowLeft' ? -1 : 1
      if (project.markers.length === 0) return
      const current = transport.positionMs
      const targetMarker =
        direction < 0
          ? [...project.markers].reverse().find((marker) => marker.positionMs < current - 1)
          : project.markers.find((marker) => marker.positionMs > current + 1)
      if (!targetMarker) return
      lastArrowSeekMs = targetMarker.positionMs
      ui.requestTimelineScrollToPosition(targetMarker.positionMs)
      transport.setPosition(targetMarker.positionMs)
      sendBridge('TRANSPORT_SEEK', { positionMs: targetMarker.positionMs })
      log.debug('transport', `marker-seek to ${targetMarker.positionMs}ms`)
      return
    }

    // Shift + Alt + Arrow: nudge the selected clip along the timeline at the
    // finest granularity (1 ms, no snap — the keyboard twin of Alt+drag). Alt
    // keeps its "granular move" meaning; Shift marks the clip (not the playhead)
    // as the target, so it never collides with Alt+Arrow's fine playhead seek.
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      e.stopPropagation()
      const target = nudgeTargetClip('shift-alt-arrow nudge')
      if (!target) return
      lastArrowSeekMs = null
      const direction = e.key === 'ArrowLeft' ? -1 : 1
      const targetMs = Math.max(0, Math.round(target.clip.startMs) + direction)
      // Bump-clamped by moveClip; same-clip moves within 500 ms coalesce into
      // one undo step on the backend, so a burst of nudges = one undo.
      project.moveClip(target.id, targetMs)
      log.debug('project', `shift-alt-arrow nudge clip ${target.id} -> ${targetMs}ms`)
      return
    }

    // Shift + Arrow: move the selected clip by one beat-grid step, snapping its
    // first in-window source beat to the project sub-beat grid (the keyboard twin
    // of a plain clip drag). Shift+Alt is the fine 1 ms variant above.
    if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      e.stopPropagation()
      const target = nudgeTargetClip('shift-arrow grid-nudge')
      if (!target) return
      const bpm = transport.bpm
      if (!Number.isFinite(bpm) || bpm <= 0) return
      lastArrowSeekMs = null
      const snap = 60_000 / bpm / SUB_BEATS_PER_BEAT
      const direction = e.key === 'ArrowLeft' ? -1 : 1
      // Snap the first in-window source beat to the grid, falling back to the
      // clip's left edge when the source has no detected beats.
      const offset = clipFirstBeatOffsetMs(target.clip, library) ?? 0
      const beatBase = target.clip.startMs + offset
      const snappedBeat =
        direction < 0
          ? Math.max(0, Math.floor((beatBase - 1e-6) / snap) * snap)
          : (Math.floor(beatBase / snap + 1e-6) + 1) * snap
      const targetMs = Math.max(0, snappedBeat - offset)
      // Bump-clamped by moveClip; same-clip moves within 500 ms coalesce into
      // one undo step on the backend.
      project.moveClip(target.id, targetMs)
      log.debug('project', `shift-arrow grid-nudge clip ${target.id} -> ${targetMs}ms`)
      return
    }

    if (e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return

    // Alt + Arrow: fine-grained step (one pixel's worth of time at the
    // current zoom). Use this when placing the playhead exactly inside a
    // clip waveform for a future split. At default zoom (100 px/s) that's
    // ~16.7 ms; at max zoom (480 px/s) it's ~2 ms. Always at least 1 ms.
    // Bare Arrow: grid step (sub-beat / 16th note).
    const direction = e.key === 'ArrowLeft' ? -1 : 1
    if (e.altKey) {
      const pxPerSec = project.viewPxPerSecond ?? 60
      const msPerPx = Math.max(1, 1000 / pxPerSec)
      const reported = transport.positionMs
      const base =
        lastArrowSeekMs !== null && Math.abs(reported - lastArrowSeekMs) < 1
          ? lastArrowSeekMs
          : reported
      const target = Math.max(0, base + direction * msPerPx)
      if (target === reported) return
      e.preventDefault()
      e.stopPropagation()
      lastArrowSeekMs = target
      transport.setPosition(target)
      ui.requestTimelineScrollToPosition(target)
      sendBridge('TRANSPORT_SEEK', { positionMs: target })
      log.debug('transport', `alt-arrow-seek to ${target.toFixed(2)}ms (${msPerPx.toFixed(2)}ms/px step)`)
      return
    }

    const bpm = transport.bpm
    if (!Number.isFinite(bpm) || bpm <= 0) return
    const msPerSub = 60_000 / bpm / SUB_BEATS_PER_BEAT

    // If our last arrow-seek target is still essentially the current
    // position (the backend's ack will have rounded by a sub-millisecond
    // at non-integer-rate BPMs), compute the next step from THAT exact
    // value rather than the rounded one. Without this, repeated arrow
    // presses can get pinned to the same grid line as floor() keeps
    // rounding the reported position to the previous bucket index.
    const reported = transport.positionMs
    const base =
      lastArrowSeekMs !== null && Math.abs(reported - lastArrowSeekMs) < 1
        ? lastArrowSeekMs
        : reported

    const target =
      direction < 0
        ? Math.max(0, Math.floor((base - 1e-6) / msPerSub) * msPerSub)
        : (Math.floor(base / msPerSub + 1e-6) + 1) * msPerSub
    if (target === reported) return

    e.preventDefault()
    e.stopPropagation()
    lastArrowSeekMs = target
    transport.setPosition(target)
    ui.requestTimelineScrollToPosition(target)
    sendBridge('TRANSPORT_SEEK', { positionMs: target })
    log.debug('transport', `arrow-seek to ${target}ms (msPerSub=${msPerSub.toFixed(2)})`)
  }

  return { onGlobalShortcutKey }
}
