// Clip Editor preview-voice scheduling, extracted from ClipEditorDialog.vue.
// Owns the debounced draft→preview pushes (warp + volume-shape), the
// always-follow playhead auto-scroll, the selection/loop playback-bounds
// enforcement, and the de-duplicated preview load. The SFC keeps the watchers
// and lifecycle hooks and calls these functions, so timer cancellation order
// on close / target switch is unchanged.
//
// Reactive inputs are passed as getters (read at call time); the preview store
// is passed directly because the scheduler both reads its state and drives its
// actions.
import type { Ref } from 'vue'
import { clampNumber } from '@/lib/clipEditor/useClipEditorWarpDraft'
import { libraryItemSourceBpm, type LibraryItem } from '@/stores/libraryStore'
import { effectiveTempoRatio, isWarpActive } from '@/lib/warp'
import type { Clip } from '@/stores/projectStore'
import type { ClipEnvelopePoint, ClipWarpMode } from '@shared/bridge-protocol'

type PreviewStore = ReturnType<typeof import('@/stores/previewStore').usePreviewStore>

export interface ClipEditorPreviewDeps {
  preview: PreviewStore
  isOpen: () => boolean
  editorItem: () => LibraryItem | null
  timelineClip: () => Clip | null
  sourceItem: () => LibraryItem | null
  editsExistingClip: () => boolean
  libraryById: () => Record<string, LibraryItem>
  projectBpm: () => number
  draftProcessorEnabled: () => boolean
  draftMode: () => ClipWarpMode
  draftSemitones: () => number
  draftCents: () => number
  previewTempoRatio: () => number | undefined
  committedEnvelopePoints: () => ClipEnvelopePoint[]
  draftReversed: () => boolean
  viewInMs: () => number
  viewDurationMs: () => number
  visibleDurationMs: () => number
  playheadAbsMs: () => number
  scrollMs: Ref<number>
  hasPlaybackSelection: () => boolean
  playbackStartMs: () => number
  playbackEndMs: () => number
  loopEnabled: () => boolean
}

export interface ClipEditorPreview {
  clearPreviewWarpUpdateTimer: () => void
  scheduleDraftPreviewWarp: () => void
  clearPreviewEnvelopeUpdateTimer: () => void
  scheduleDraftPreviewEnvelope: () => void
  pushDraftPreviewReversed: () => void
  autoFollowPlayhead: () => void
  enforceSelectionPlaybackBounds: () => void
  loadPreviewForView: () => void
  resetPreviewLoadKey: () => void
}

export function useClipEditorPreview(deps: ClipEditorPreviewDeps): ClipEditorPreview {
  const { preview } = deps
  let lastPreviewLoadKey = ''
  let previewWarpUpdateTimer: number | null = null

  function resetPreviewLoadKey(): void {
    lastPreviewLoadKey = ''
  }

  function clearPreviewWarpUpdateTimer(): void {
    if (previewWarpUpdateTimer === null) return
    window.clearTimeout(previewWarpUpdateTimer)
    previewWarpUpdateTimer = null
  }

  function sendDraftPreviewWarp(): void {
    previewWarpUpdateTimer = null
    if (!deps.isOpen() || !deps.editsExistingClip() || !preview.isLoaded) return
    preview.setWarp({
      warpEnabled: deps.draftProcessorEnabled(),
      warpMode: deps.draftMode(),
      tempoRatio: deps.previewTempoRatio() ?? null,
      semitones: clampNumber(deps.draftSemitones(), -12, 12),
      cents: clampNumber(deps.draftCents(), -100, 100)
    })
  }

  function scheduleDraftPreviewWarp(): void {
    if (!deps.isOpen() || !deps.editsExistingClip() || !preview.isLoaded) return
    if (previewWarpUpdateTimer !== null) return
    previewWarpUpdateTimer = window.setTimeout(sendDraftPreviewWarp, 33)
  }

  // Volume-shape draft → preview voice. A 33ms throttle so dragging a
  // breakpoint auditions live without flooding the bridge.
  let previewEnvelopeUpdateTimer: number | null = null
  function clearPreviewEnvelopeUpdateTimer(): void {
    if (previewEnvelopeUpdateTimer === null) return
    window.clearTimeout(previewEnvelopeUpdateTimer)
    previewEnvelopeUpdateTimer = null
  }
  function sendDraftPreviewEnvelope(): void {
    previewEnvelopeUpdateTimer = null
    if (!deps.isOpen() || !deps.editsExistingClip() || !preview.isLoaded) return
    preview.setEnvelope(deps.committedEnvelopePoints())
  }
  function scheduleDraftPreviewEnvelope(): void {
    if (!deps.isOpen() || !deps.editsExistingClip() || !preview.isLoaded) return
    if (previewEnvelopeUpdateTimer !== null) return
    previewEnvelopeUpdateTimer = window.setTimeout(sendDraftPreviewEnvelope, 33)
  }

  // Reverse is a single toggle (no drag), so push it immediately rather than
  // throttling like the envelope/warp drafts.
  function pushDraftPreviewReversed(): void {
    if (!deps.isOpen() || !deps.editsExistingClip() || !preview.isLoaded) return
    preview.setReversed(deps.draftReversed())
  }

  // While the preview is playing, keep the playhead visible on the canvas
  // (always-follow, regardless of the main timeline's followPlayback pref).
  // Behaviour mirrors the main timeline: scroll forward only, recentre the
  // playhead when it crosses past ~75% of the way across the visible window.
  let lastFollowMs = 0
  function autoFollowPlayhead(): void {
    const fullDur = deps.viewDurationMs()
    const visDur = deps.visibleDurationMs()
    if (fullDur <= 0 || visDur <= 0 || visDur >= fullDur - 0.5) {
      lastFollowMs = 0
      return
    }
    if (!preview.isPlaying) {
      lastFollowMs = 0
      return
    }
    const now = performance.now()
    const dtSec = lastFollowMs === 0 ? 0 : Math.min(0.1, (now - lastFollowMs) / 1000)
    lastFollowMs = now

    const phRel = deps.playheadAbsMs() - deps.viewInMs()
    const maxScroll = Math.max(0, fullDur - visDur)
    const desired = Math.max(0, Math.min(maxScroll, phRel - visDur / 2))

    // Match useTimelineDrawing: hold scroll if target is behind us (avoids
    // jarring backward teleports), and ease in when ahead.
    if (desired <= deps.scrollMs.value) return
    const gap = desired - deps.scrollMs.value
    if (gap <= 0.5) return
    // In ms-space, playback advances at 1000 ms (source) per 1 s (real).
    // Approach rate = 3× playback; proportional term closes a gap in ~0.2s.
    const approachMsPerSec = 1000 * 3
    const proportionalMsPerSec = gap * 5
    const ratePerSec = Math.max(approachMsPerSec, proportionalMsPerSec)
    const step = Math.min(gap, ratePerSec * dtSec)
    if (step > 0) {
      deps.scrollMs.value = Math.max(0, Math.min(maxScroll, deps.scrollMs.value + step))
    }
  }

  // When a selection is active, playback is bounded by it. As soon as
  // the playhead reaches the selection end, pause and rewind to the
  // selection start so the next Play press replays the section.
  // Natural end-of-window (the entire preview window finished playing)
  // is handled separately via the `endedCount` watcher in the SFC
  // — applyEnded resets positionMs to 0, so a position-based check
  // here can't detect that transition.
  function enforceSelectionPlaybackBounds(): void {
    if (!preview.isPlaying) return

    if (!deps.editorItem()) return
    const hasSel = deps.hasPlaybackSelection()
    // When loop is enabled, loop the active playback window: the selection if
    // there is one, otherwise the whole preview window. This applies to any
    // editor item (timeline clips, saved clips, and standalone library samples
    // opened directly), so a music/simple sample loops just like a clip.
    const looping = deps.loopEnabled()

    // While playing, enforce the selection bounds before reaching the
    // natural end of the preview window.
    if (!hasSel && !looping) return
    const pos = preview.positionMs
    const endRel = deps.playbackEndMs() - deps.viewInMs()
    if (pos < endRel - 0.5) return
    const startRel = Math.max(0, deps.playbackStartMs() - deps.viewInMs())
    if (looping) {
      preview.seek(startRel)
    } else {
      preview.pause()
      preview.seek(startRel)
    }
  }

  function loadPreviewForView(): void {
    const entry = deps.editorItem()
    if (!entry) return
    const src = deps.sourceItem()
    if (!src) return
    // Pass any warp defaults stored on the library item (saved-clips
    // carry the user's preferred warp at the time the clip was saved)
    // so the preview voice plays the clip the way the timeline will.
    // Audio-file items don't carry warp metadata, so the spread is a
    // no-op for them.
    const previewSourceBpm = libraryItemSourceBpm(entry, deps.libraryById())
    const current = deps.timelineClip() ?? entry
    const tempoRatio = isWarpActive({
      warpEnabled: current.warpEnabled,
      tempoRatio: current.tempoRatio,
      sourceBpm: previewSourceBpm,
      projectBpm: deps.projectBpm()
    })
      ? effectiveTempoRatio({
          tempoRatio: current.tempoRatio,
          sourceBpm: previewSourceBpm,
          projectBpm: deps.projectBpm()
        })
      : current.tempoRatio
    const warp = deps.editsExistingClip()
      ? {
          warpEnabled: deps.draftProcessorEnabled(),
          warpMode: deps.draftMode(),
          tempoRatio: deps.previewTempoRatio(),
          semitones: deps.draftSemitones(),
          cents: deps.draftCents()
        }
      : {
          warpEnabled: current.warpEnabled,
          warpMode: current.warpMode,
          tempoRatio,
          semitones: current.semitones,
          cents: current.cents
        }
    const loadKey = JSON.stringify({
      sourceId: src.id,
      inMs: deps.viewInMs(),
      durationMs: deps.viewDurationMs(),
      warp
    })
    if (loadKey === lastPreviewLoadKey) return
    lastPreviewLoadKey = loadKey
    preview.load(src.id, deps.viewInMs(), deps.viewDurationMs(), warp)
  }

  return {
    clearPreviewWarpUpdateTimer,
    scheduleDraftPreviewWarp,
    clearPreviewEnvelopeUpdateTimer,
    scheduleDraftPreviewEnvelope,
    pushDraftPreviewReversed,
    autoFollowPlayhead,
    enforceSelectionPlaybackBounds,
    loadPreviewForView,
    resetPreviewLoadKey
  }
}
