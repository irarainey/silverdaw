// Repaint watches: the cluster of reactive watchers that observe project, library,
// transport, and UI state and request a timeline rebuild / playhead repaint.
// Each watcher sources a distinct reactive input, so they are order-independent
// and move verbatim out of the view controller without changing flush behaviour.

import { watch, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, libraryItemDisplayName, libraryItemSourceBpm } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'

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
  const library = useLibraryStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const { redraw, updatePlayhead, clampScroll, applyScroll, horizontalRebuildNeeded } = deps

  watch(
    () => [project.tracks.length, Object.keys(project.clips).length] as const,
    () => {
      redraw()
      updatePlayhead()
    }
  )

  watch(
    () => Object.values(project.clips)
      .map((clip) => [
        clip.id,
        clip.warpEnabled === true ? 1 : 0,
        clip.pendingAutoWarp === true ? 1 : 0,
        clip.warpMode ?? '',
        clip.tempoRatio ?? '',
        clip.semitones ?? '',
        clip.cents ?? ''
      ].join(':'))
      .join('|'),
    () => {
      redraw()
      updatePlayhead()
    }
  )

  watch(
    () => Object.values(project.clips)
      .map((clip) => {
        const item = library.byId[clip.libraryItemId]
        const sourceBpm = item ? libraryItemSourceBpm(item, library.byId) : undefined
        return [
          clip.id,
          clip.libraryItemId,
          item?.kind ?? '',
          item ? libraryItemDisplayName(item) : '',
          item?.durationMs ?? '',
          item?.derivedFrom?.inMs ?? '',
          item?.derivedFrom?.durationMs ?? '',
          sourceBpm ?? ''
        ].join(':')
      })
      .join('|'),
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

  // Peaks revision avoids a deep watch on clip waveform data.
  watch(
    () => project.peaksRevision,
    () => redraw()
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
}
