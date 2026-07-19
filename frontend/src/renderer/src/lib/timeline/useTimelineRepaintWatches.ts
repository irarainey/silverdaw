// Repaint watches: the cluster of reactive watchers that observe project, library,
// transport, and UI state and request a timeline rebuild / playhead repaint.
// Each watcher sources a distinct reactive input, so they are order-independent
// and move verbatim out of the view controller without changing flush behaviour.

import { watch, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { useBrakeSettingsStore } from '@/stores/brakeSettingsStore'
import { useBackspinSettingsStore } from '@/stores/backspinSettingsStore'

export interface TimelineRepaintWatchesDeps {
  redraw: () => void
  updatePlayhead: () => void
  clampScroll: () => boolean
  applyScroll: () => void
  horizontalRebuildNeeded: () => boolean
  scrollX: Ref<number>
  scrollY: Ref<number>
  headerWidthRef: Ref<number>
}

export function useTimelineRepaintWatches(deps: TimelineRepaintWatchesDeps): void {
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const brakeSettings = useBrakeSettingsStore()
  const backspinSettings = useBackspinSettingsStore()
  const { redraw, updatePlayhead, clampScroll, applyScroll, horizontalRebuildNeeded } = deps

  // Mutation actions bump this scalar instead of forcing Vue to serialize every
  // clip's geometry, warp, appearance, library, and peak state on each change.
  watch(
    () => project.timelineRevision,
    () => {
      redraw()
      updatePlayhead()
    }
  )

  // Track-height changes affect row positions and vertical scrollbar geometry.
  watch(
    () => project.tracks.map((t) => t.heightPx ?? 0).join(','),
    () => {
      clampScroll()
      redraw()
      updatePlayhead()
    }
  )

  // Both scroll axes change which content falls inside the culled draw window
  // (vertical = which rows; horizontal = which clip/grid/tick band). Vertical
  // scroll always rebuilds. Horizontal scroll translates the band immediately
  // (O(1), crisp this frame) and only schedules a coalesced rebuild once it
  // drifts past the overscan threshold — so panning and playback auto-follow
  // stay translate-only per frame instead of rebuilding the scene each tick.
  watch(deps.scrollX, () => {
    applyScroll()
    if (horizontalRebuildNeeded()) redraw()
  })
  watch(deps.scrollY, () => redraw())

  watch(
    () => ui.waveformDisplayMode,
    () => redraw()
  )

  // Track pan affects stereo waveform lane height/opacity.
  watch(
    () => project.tracks.map((t) => t.pan ?? 0).join(','),
    () => redraw()
  )

  // Static Track FX values are the automation lane's resting baseline line, so a
  // change to Tone / Filter / sends / Compressor must repaint the open lane.
  watch(
    () =>
      project.tracks
        .map((t) =>
          [t.toneBassDb, t.toneMidDb, t.toneTrebleDb, t.toneFilter, t.reverbSend, t.delaySend, t.levelerAmount, t.punchAmount, t.saturationDrive, t.saturationMix, t.bitCrusherRate, t.bitCrusherBits, t.bitCrusherBoost, t.bitCrusherMix]
            .map((v) => v ?? 0)
            .join(',')
        )
        .join('|'),
    () => redraw()
  )

  watch(
    () => project.markers.map((marker) => `${marker.id}:${marker.positionMs}`).join('|'),
    () => redraw()
  )

  // Automation lane expand/collapse + param switch.
  watch(
    () => Object.entries(ui.automationLanes).map(([k, v]) => `${k}:${v}`).join('|'),
    () => redraw()
  )

  // Transition overlays can change without clip movement.
  watch(
    () =>
      project.tracks
        .map((t) =>
          (t.transitions ?? [])
            .map((tr) => `${tr.id}:${tr.leftClipId}>${tr.rightClipId}:${tr.recipe.kind}`)
            .join(',')
        )
        .join('|'),
    () => redraw()
  )

  // Beat Repeat regions are beat-space; both region edits and BPM changes alter their footprint.
  watch(
    () =>
      project.tracks
        .map((track) =>
          (track.beatRepeats ?? [])
            .map((region) =>
              `${region.id}:${region.startBeat}:${region.lengthBeats}:${region.division}`
            )
            .join(',')
        )
        .join('|'),
    () => redraw()
  )

  // BPM drives ruler ticks, grid lines, and snap units.
  watch(() => transport.bpm, () => {
    redraw()
    updatePlayhead()
  })

  // Ruler bar labels depend on the project's bar-counter offset.
  watch(() => project.barCounterStart, () => {
    redraw()
  })

  // Header width participates in cached x positions.
  watch(deps.headerWidthRef, () => {
    redraw()
    updatePlayhead()
  })

  // Project length changes affect grid extent even when clip counts stay unchanged.
  watch(
    () => project.durationMs,
    () => redraw()
  )

  // Brake / backspin defaults (the app preference) drive the tail-overlay extent
  // and curve shape, so a change must repaint every braked / backspun clip.
  watch(
    () => [
      brakeSettings.seconds,
      brakeSettings.curvePower,
      backspinSettings.seconds,
      backspinSettings.curvePower
    ] as const,
    () => redraw()
  )
}
