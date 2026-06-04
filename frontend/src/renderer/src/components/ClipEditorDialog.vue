<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { usePreviewStore } from '@/stores/previewStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { useTransportStore } from '@/stores/transportStore'
import { effectiveClipDurationMs, useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { formatTime } from '@/lib/musicTime'
import { isWarpActive } from '@/lib/warp'
import { useClipEditorTarget } from '@/lib/clipEditor/useClipEditorTarget'
import {
  MAX_ZOOM,
  useClipEditorViewport
} from '@/lib/clipEditor/useClipEditorViewport'
import {
  currentHasTempoWarp,
  useClipEditorWarpDraft
} from '@/lib/clipEditor/useClipEditorWarpDraft'
import { useClipEditorVolumeShapeDraft } from '@/lib/clipEditor/useClipEditorVolumeShapeDraft'
import { useClipEditorWaveform } from '@/lib/clipEditor/useClipEditorWaveform'
import { useClipEditorPreview } from '@/lib/clipEditor/useClipEditorPreview'
import { useClipEditorCropHistory } from '@/lib/clipEditor/useClipEditorCropHistory'
import { useClipEditorSave } from '@/lib/clipEditor/useClipEditorSave'
import { useClipEditorCanvasInteraction } from '@/lib/clipEditor/useClipEditorCanvasInteraction'
import { useClipEditorKeyboard } from '@/lib/clipEditor/useClipEditorKeyboard'
import ClipEditorWarpPanel from '@/components/ClipEditorWarpPanel.vue'
import ClipEditorPitchPanel from '@/components/ClipEditorPitchPanel.vue'
import ClipEffectModule from '@/components/ClipEffectModule.vue'

const props = defineProps<{
  open: boolean
  item?: LibraryItem | null
  clipId?: string | null
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const preview = usePreviewStore()
const project = useProjectStore()
const library = useLibraryStore()
const notifications = useNotificationsStore()
const ui = useUiStore()
const transport = useTransportStore()

const dialogEl = ref<HTMLDivElement | null>(null)
const waveformEl = ref<HTMLCanvasElement | null>(null)

// Target-mode resolution (which kind of editing the dialog is doing
// for the current `(item, clipId)` open arguments) lives in a
// composable so the kind-check is exhaustive and single-sourced.
const itemRef = toRef(props, 'item')
const clipIdRef = toRef(props, 'clipId')
const {
  timelineClip,
  editorItem,
  editsExistingClip,
  editsSavedClipLibrary,
  editsSingleTimelineClip,
  titleText,
  sourceItem,
  sourceDurationMs,
  sourceBpm,
  sourceKey
} = useClipEditorTarget(itemRef, clipIdRef)

// Draft warp + pitch state for the inline inspector. The dialog
// reseeds it on every target switch via `initialiseWarpDraft()`.
const warpDraft = useClipEditorWarpDraft(sourceBpm)
const {
  draftTempoEnabled,
  draftMode,
  draftTempoPinned,
  draftPinnedBpm,
  draftSemitones,
  draftCents,
  draftTempoWarpActive,
  draftProcessorEnabled,
  tempoRatioFromPinnedBpm,
  previewTempoRatio,
  initialise: initialiseWarpDraft
} = warpDraft

// Draft volume-shape (gain envelope) state. Same transactional pattern:
// the dialog owns the hook, the panel binds to it, Save commits via
// `setClipEnvelope`, Cancel discards.
const volumeShapeDraft = useClipEditorVolumeShapeDraft()
const {
  hasChanged: hasVolumeShapeChanged,
  initialise: initialiseVolumeShapeDraft,
  committedPoints: volumeShapeCommittedPoints
} = volumeShapeDraft

// "Volume" edit mode for the waveform: when on, the canvas pointer edits
// the gain envelope (add / drag / delete breakpoints) instead of the
// selection. Only meaningful in the cropped Clip view, where the envelope
// spans the whole clip; toggled off automatically in Source view.
const volumeEditMode = ref(false)

// Whether the most recent `drawWaveform` rendered the waveform as two
// stacked stereo lanes. The Volume Shape overlay mirrors its envelope
// into each lane when true, and the canvas pointer handler reads this to
// hit-test handles + map gain across both lanes. Kept as a ref (set by
// `drawWaveform`) so the pointer geometry always matches what was drawn.
const waveformStereoLanes = ref(false)

// Effective (post-warp) audible duration of the clip being edited — the
// horizontal span of the volume-shape editor and the basis its endpoints
// are pinned to. Matches the ms basis the backend persists the envelope in.
const volumeShapeDurationMs = computed(() => {
  const clip = timelineClip.value
  if (!clip) return 0
  return effectiveClipDurationMs(clip)
})

// The envelope overlay is a single-timeline-clip feature shown over the
// cropped Clip view (where the breakpoint axis spans the whole clip).
const volumeShapeAvailable = computed(
  () => editsSingleTimelineClip.value && !viewExpanded.value && volumeShapeDurationMs.value > 0
)
// Pointer edits the envelope (vs the selection) only while the Volume
// toggle is on and the overlay is actually shown.
const volumeEditActive = computed(() => volumeEditMode.value && volumeShapeAvailable.value)


const warpActive = computed(() => {
  const entry = editorItem.value
  if (!entry) return false
  if (editsExistingClip.value) return draftTempoWarpActive.value
  return isWarpActive({
    warpEnabled: entry.warpEnabled,
    tempoRatio: entry.tempoRatio,
    sourceBpm: sourceBpm.value,
    projectBpm: transport.bpm
  })
})

// Viewport, zoom, scroll, and selection state for the canvas live in
// a composable. The dialog still drives the canvas DOM and the mouse
// handlers, but the math + bounds + multi-field transitions are
// owned (and unit-tested) in `useClipEditorViewport`.
const viewport = useClipEditorViewport({
  editorItem,
  editsExistingClip,
  timelineClip,
  sourceDurationMs,
  uiZoomPxPerSecond: toRef(ui, 'zoomPxPerSecond')
})
const {
  viewExpanded,
  cropViewInMs,
  cropViewDurationMs,
  selectionInMs,
  selectionDurationMs,
  zoom,
  scrollMs,
  canvasCssWidth,
  viewInMs,
  viewDurationMs,
  viewEndMs,
  basePxPerMs: _basePxPerMs,
  visibleDurationMs,
  maxScrollMs,
  visibleInMs,
  visibleEndMs,
  zoomPercent,
  selectionEndMs,
  hasPlaybackSelection,
  playbackStartMs,
  playbackEndMs,
  resetZoom,
  setZoomAnchored,
  zoomIn,
  zoomOut
} = viewport
void _basePxPerMs


// Selection / playback range computeds owned by `useClipEditorViewport`;
// `selectionInMs` / `selectionDurationMs` / `selectionEndMs` /
// `hasPlaybackSelection` / `playbackStartMs` / `playbackEndMs` are
// destructured at the top of this <script setup>.

// Has the user changed anything from the persisted saved-clip window?
// True when EITHER the selection is narrower than the cropped view,
// OR the cropped view itself differs from `derivedFrom` (because the
// user clicked Crop one or more times). Apply trim is enabled in
// either case — the act of Apply uses the current selection.
const hasSelectionChanged = computed(() => {
  if (!editsExistingClip.value) return false
  const clip = timelineClip.value
  const entry = editorItem.value
  if (!entry) return false
  const origIn = clip?.inMs ?? entry.derivedFrom?.inMs ?? 0
  const origDur = clip?.durationMs ?? entry.derivedFrom?.durationMs ?? entry.durationMs
  if (selectionInMs.value !== origIn || selectionDurationMs.value !== origDur) return true
  if (cropViewInMs.value !== origIn || cropViewDurationMs.value !== origDur) return true
  return false
})

const hasWarpPitchChanged = computed(() => {
  const current = timelineClip.value ?? editorItem.value
  if (!current || !editsExistingClip.value) return false
  const currentTempoEnabled = currentHasTempoWarp(current)
  const currentTempoPinned = typeof current.tempoRatio === 'number' && current.tempoRatio > 0 && current.tempoRatio !== 1
  const currentPinnedBpm =
    currentTempoPinned && typeof sourceBpm.value === 'number' && sourceBpm.value > 0 && typeof current.tempoRatio === 'number'
      ? Math.round(sourceBpm.value * current.tempoRatio * 100) / 100
      : Math.round(transport.bpm * 100) / 100
  return (
    draftTempoEnabled.value !== currentTempoEnabled ||
    draftMode.value !== (current.warpMode ?? 'rhythmic') ||
    draftTempoPinned.value !== currentTempoPinned ||
    Math.abs(draftPinnedBpm.value - currentPinnedBpm) > 0.005 ||
    draftSemitones.value !== (current.semitones ?? 0) ||
    draftCents.value !== (current.cents ?? 0)
  )
})

const canSaveChanges = computed(() => {
  if (!editsExistingClip.value) return false
  // The volume shape only persists on single-timeline-clip edits today
  // (saved-clip library updates don't carry shape defaults). Don't let a
  // shape-only edit enable Save in modes where it would be silently dropped.
  const volumeShapeDirty = editsSingleTimelineClip.value && hasVolumeShapeChanged.value
  return hasSelectionChanged.value || hasWarpPitchChanged.value || volumeShapeDirty
})

// Non-destructive crop: snap the cropped working view to the current
// selection so the user can audition / fine-tune the new range
// before committing it to the library. Enabled whenever there's a
// narrowing selection (selection strictly inside the cropped view).
const canApplyCrop = computed(() => {
  if (!editorItem.value) return false
  if (selectionDurationMs.value <= 0) return false
  return (
    selectionInMs.value > cropViewInMs.value + 0.5 ||
    selectionEndMs.value < cropViewInMs.value + cropViewDurationMs.value - 0.5
  )
})

const canSaveAsNew = computed(() => {
  return !editsExistingClip.value && !!sourceItem.value && selectionDurationMs.value > 0
})

const playheadAbsMs = computed(() => viewInMs.value + preview.positionMs)

const loopEnabled = ref(false)

// Preview-voice scheduling (debounced draft pushes, follow-playhead,
// selection/loop bounds, de-duped load) lives in a composable; the SFC keeps
// the watchers + lifecycle hooks and calls these.
const {
  clearPreviewWarpUpdateTimer,
  scheduleDraftPreviewWarp,
  clearPreviewEnvelopeUpdateTimer,
  scheduleDraftPreviewEnvelope,
  autoFollowPlayhead,
  enforceSelectionPlaybackBounds,
  loadPreviewForView,
  resetPreviewLoadKey
} = useClipEditorPreview({
  preview,
  isOpen: () => props.open,
  editorItem: () => editorItem.value,
  timelineClip: () => timelineClip.value,
  sourceItem: () => sourceItem.value,
  editsExistingClip: () => editsExistingClip.value,
  libraryById: () => library.byId,
  projectBpm: () => transport.bpm,
  draftProcessorEnabled: () => draftProcessorEnabled.value,
  draftMode: () => draftMode.value,
  draftSemitones: () => draftSemitones.value,
  draftCents: () => draftCents.value,
  previewTempoRatio,
  committedEnvelopePoints: volumeShapeCommittedPoints,
  viewInMs: () => viewInMs.value,
  viewDurationMs: () => viewDurationMs.value,
  visibleDurationMs: () => visibleDurationMs.value,
  playheadAbsMs: () => playheadAbsMs.value,
  scrollMs,
  hasPlaybackSelection: () => hasPlaybackSelection.value,
  playbackStartMs: () => playbackStartMs.value,
  playbackEndMs: () => playbackEndMs.value,
  loopEnabled: () => loopEnabled.value
})

watch(
  () => props.open,
  async (open) => {
    ui.clipEditorOpen = open
    if (open) {
      viewExpanded.value = false
      resetZoom()
      initSelectionForItem()
      initialiseWarpDraft(timelineClip.value ?? editorItem.value, editsExistingClip.value)
      initialiseVolumeShapeDraft(timelineClip.value, volumeShapeDurationMs.value)
      volumeEditMode.value = false
      loopEnabled.value = false
      resetHiResRequestKey()
      resetCropHistory()
      library.setEditorHiResPeaks(null)
      await nextTick()
      if (waveformEl.value) {
        canvasCssWidth.value = waveformEl.value.getBoundingClientRect().width
      }
      drawWaveform()
      dialogEl.value?.focus()
      loadPreviewForView()
    } else {
      clearPreviewWarpUpdateTimer()
      clearPreviewEnvelopeUpdateTimer()
      preview.unload()
      resetPreviewLoadKey()
      library.setEditorHiResPeaks(null)
      resetHiResRequestKey()
      resetCropHistory()
    }
  }
)

watch(
  [() => props.item?.id, () => props.clipId],
  () => {
    if (!props.open) return
    viewExpanded.value = false
    volumeEditMode.value = false
    resetZoom()
    resetPreviewLoadKey()
    initSelectionForItem()
    initialiseWarpDraft(timelineClip.value ?? editorItem.value, editsExistingClip.value)
    initialiseVolumeShapeDraft(timelineClip.value, volumeShapeDurationMs.value)
    resetHiResRequestKey()
    resetCropHistory()
    library.setEditorHiResPeaks(null)
    drawWaveform()
    loadPreviewForView()
  }
)

watch(
  [draftTempoEnabled, draftMode, draftTempoPinned, draftPinnedBpm, draftSemitones, draftCents],
  () => {
    scheduleDraftPreviewWarp()
  }
)

// Audition the volume-shape draft live. The hook reassigns the points
// ref on every edit, so a shallow watch fires on each breakpoint change.
// Also redraws so the on-waveform envelope overlay tracks the edit.
watch(
  () => volumeShapeDraft.draftPoints.value,
  () => {
    scheduleDraftPreviewEnvelope()
    drawWaveform()
  }
)

// Redraw when the Volume edit toggle flips so the overlay appears/disappears
// immediately, even before any breakpoint has been edited.
watch(volumeEditActive, () => {
  drawWaveform()
})

// PREVIEW_LOAD is async. If the user edits the volume shape between
// sending the load and the backend signalling isLoaded=true, those
// `setEnvelope` calls are no-ops (gated on isLoaded). Re-push the
// current draft once the preview transitions to loaded so the voice
// always matches the UI.
watch(
  () => preview.isLoaded,
  (loaded, prev) => {
    if (!loaded || loaded === prev) return
    if (!props.open || !editsExistingClip.value) return
    preview.setEnvelope(volumeShapeCommittedPoints())
  }
)

// Toggling view-expanded changes viewInMs/viewDurationMs which
// affect every downstream computation. Reset zoom (so the new view
// fits the canvas at 1x), redraw, and reload the preview voice
// against the new bounds.
//
// On collapse (Source → Clip): the cropped-view bounds snap to the
// current selection. The user often goes to Source view specifically
// to mark a bigger range; switching back, we want the new range to
// become the focused clip view so they can fine-tune inside it. The
// selection then covers the full view (no narrowing), which gives
// the user a clean canvas to drag the handles inward from.
//
// On expansion (Clip → Source): scroll so the selection (the current
// clip window) sits inside the visible window — saves the user from
// hunting for it on long sources.
watch(viewExpanded, async (expanded) => {
  if (expanded) {
    // The envelope overlay spans the cropped clip; leaving Clip view
    // exits Volume edit mode so the canvas returns to selection editing.
    volumeEditMode.value = false
  }
  if (!expanded) {
    // Snap the cropped view to the user's current selection so it
    // becomes the new focused range. Fall back to keeping the
    // existing crop when the selection has been cleared (the
    // composable's helper is a no-op in that case).
    viewport.snapCropViewToSelection()
  }
  resetZoom()
  scrollMs.value = 0
  await nextTick()
  if (expanded) {
    // Centre the visible window on the selection midpoint when it's
    // not already inside the visible window. resetZoom + scrollMs=0
    // above already shows from the start; on long sources that may
    // not include the selection.
    const selMid = (selectionInMs.value + selectionEndMs.value) / 2 - viewInMs.value
    const visLeft = scrollMs.value
    const visRight = visLeft + visibleDurationMs.value
    if (selMid < visLeft || selMid > visRight) {
      const target = selMid - visibleDurationMs.value / 2
      scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, target))
    }
  }
  drawWaveform()
  loadPreviewForView()
})

watch(
  [() => preview.positionMs, () => preview.isPlaying],
  () => {
    enforceSelectionPlaybackBounds()
    autoFollowPlayhead()
    drawWaveform()
  }
)

watch(
  [
    selectionInMs,
    selectionDurationMs,
    cropViewInMs,
    cropViewDurationMs,
    zoom,
    scrollMs,
    canvasCssWidth,
    () => ui.zoomPxPerSecond,
    () => ui.waveformDisplayMode,
    () => library.editorHiResPeaks
  ],
  () => {
    drawWaveform()
  }
)

// Loop restart on natural end-of-window. The preview store resets
// positionMs to 0 in applyEnded, so the position-watcher's
// "playhead near end" check can't fire after a natural end. Watching
// the endedCount counter gives us a reliable signal to restart.
watch(
  () => preview.endedCount,
  (n, prev) => {
    if (n === prev) return
    if (!editorItem.value) return
    const looping = loopEnabled.value && (hasPlaybackSelection.value || editsExistingClip.value)
    if (!looping) return
    const startRel = Math.max(0, playbackStartMs.value - viewInMs.value)
    preview.seek(startRel)
    preview.play()
  }
)

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  // Track canvas CSS width so basePxPerMs / visibleDurationMs react to
  // dialog resizes (the canvas resizes with the window).
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const w = entry.contentRect.width
      if (w > 0 && Math.abs(w - canvasCssWidth.value) > 0.5) {
        canvasCssWidth.value = w
      }
    })
  }
  // Window-level capture-phase listener for the dialog's local
  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z. Beats the menu-accelerator
  // binding in `menuShortcuts.ts` to the punch and is independent
  // of where focus lives inside the dialog (which can drift to any
  // canvas / button / scrollbar element). The handler is a no-op
  // when the dialog isn't open.
  window.addEventListener('keydown', onWindowKeydownCapture, { capture: true })
})

watch(
  () => waveformEl.value,
  (el) => {
    if (!resizeObserver) return
    resizeObserver.disconnect()
    if (el) {
      resizeObserver.observe(el)
      canvasCssWidth.value = el.getBoundingClientRect().width
    }
  }
)

onBeforeUnmount(() => {
  ui.clipEditorOpen = false
  clearPreviewWarpUpdateTimer()
  clearPreviewEnvelopeUpdateTimer()
  preview.unload()
  window.removeEventListener('keydown', onWindowKeydownCapture, { capture: true })
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})

function initSelectionForItem(): void {
  viewport.initialiseForItem()
}


// On-demand high-resolution peaks + the canvas waveform renderer live in a
// composable so this SFC stays focused on orchestration. The renderer writes
// back the last-rendered stereo-lane layout into `waveformStereoLanes` (owned
// here) because the canvas pointer hit-testing reads that layout.
const { drawWaveform, ensureEditorHiResPeaks, resetHiResRequestKey } = useClipEditorWaveform({
  getCanvas: () => waveformEl.value,
  sourceItem: () => sourceItem.value,
  sourceDurationMs: () => sourceDurationMs.value,
  zoom: () => zoom.value,
  visibleInMs: () => visibleInMs.value,
  visibleDurationMs: () => visibleDurationMs.value,
  visibleEndMs: () => visibleEndMs.value,
  viewInMs: () => viewInMs.value,
  viewEndMs: () => viewEndMs.value,
  selectionInMs: () => selectionInMs.value,
  selectionEndMs: () => selectionEndMs.value,
  selectionDurationMs: () => selectionDurationMs.value,
  editsExistingClip: () => editsExistingClip.value,
  playheadAbsMs: () => playheadAbsMs.value,
  volumeShapeAvailable: () => volumeShapeAvailable.value,
  volumeEditActive: () => volumeEditActive.value,
  volumeShapeDurationMs: () => volumeShapeDurationMs.value,
  draftPoints: () => volumeShapeDraft.draftPoints.value,
  draftEffectiveRatio: () => warpDraft.draftEffectiveRatio.value,
  editorHiResPeaks: () => library.editorHiResPeaks,
  channelPeaksByItemId: () => library.channelPeaksByItemId,
  waveformDisplayMode: () => ui.waveformDisplayMode,
  waveformStereoLanes
})

// Trigger a hi-res request whenever the user zooms in past the threshold.
watch(zoom, () => ensureEditorHiResPeaks())

const {
  onCanvasMouseDown,
  onCanvasContextMenu,
  onCanvasWheel,
  onScrollbarMouseDown,
  nudgePlayhead,
  extendSelection,
  clearSelection
} = useClipEditorCanvasInteraction({
  getCanvas: () => waveformEl.value,
  preview,
  volumeShapeDraft,
  selectionInMs,
  selectionDurationMs,
  scrollMs,
  waveformStereoLanes,
  viewInMs: () => viewInMs.value,
  viewEndMs: () => viewEndMs.value,
  viewDurationMs: () => viewDurationMs.value,
  visibleInMs: () => visibleInMs.value,
  visibleDurationMs: () => visibleDurationMs.value,
  selectionEndMs: () => selectionEndMs.value,
  maxScrollMs: () => maxScrollMs.value,
  playheadAbsMs: () => playheadAbsMs.value,
  hasPlaybackSelection: () => hasPlaybackSelection.value,
  volumeEditActive: () => volumeEditActive.value,
  volumeShapeDurationMs: () => volumeShapeDurationMs.value,
  draftEffectiveRatio: () => warpDraft.draftEffectiveRatio.value,
  sourceItem: () => sourceItem.value,
  zoom: () => zoom.value,
  setZoomAnchored
})

function onTogglePlay(): void {
  if (!preview.isLoaded) return
  if (preview.isPlaying) {
    preview.pause()
    return
  }
  const hasSel = hasPlaybackSelection.value
  // Bound playback by the selection if narrowed, or by the full clip
  // when looping a saved clip with no selection.
  const bounded = hasSel || (editsExistingClip.value && loopEnabled.value)
  if (bounded) {
    const startRel = playbackStartMs.value - viewInMs.value
    const endRel = playbackEndMs.value - viewInMs.value
    const pos = preview.positionMs
    if (pos < startRel - 0.5 || pos >= endRel - 0.5) {
      preview.seek(Math.max(0, startRel))
    }
  }
  preview.play()
}

function onSkipToStart(): void {
  const rel = Math.max(0, playbackStartMs.value - viewInMs.value)
  preview.seek(rel)
  // Scroll the canvas so the playhead's new position is visible.
  // Auto-follow only ever scrolls forward, so without this the
  // playhead would land off-screen to the left when scrolled in.
  if (rel < scrollMs.value) {
    scrollMs.value = rel
  }
}

function onSkipToEnd(): void {
  const end = Math.max(0, playbackEndMs.value - viewInMs.value - 1)
  preview.seek(end)
  // Ensure the end position is on-screen.
  const visDur = visibleDurationMs.value
  if (end > scrollMs.value + visDur) {
    scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, end - visDur / 2))
  }
}

function onToggleLoop(): void {
  loopEnabled.value = !loopEnabled.value
}


// Dialog-local Crop undo/redo history lives in a composable. Crop is purely
// non-destructive (it narrows the working view); Apply trim commits through the
// project-wide UndoManager. The stack is scoped to the dialog so closing it
// discards any uncommitted crops.
const { onApplyCrop, undoCropLocal, redoCropLocal, resetCropHistory } =
  useClipEditorCropHistory({
    canApplyCrop: () => canApplyCrop.value,
    captureCropSnapshot: () => viewport.captureCropSnapshot(),
    restoreCropSnapshot: (snap) => viewport.restoreCropSnapshot(snap),
    cropViewInMs,
    cropViewDurationMs,
    selectionInMs: () => selectionInMs.value,
    selectionDurationMs: () => selectionDurationMs.value,
    resetZoom,
    redraw: () => drawWaveform(),
    reloadPreview: () => loadPreviewForView()
  })
const { onSaveChanges, onSaveAsNew } = useClipEditorSave({
  project,
  library,
  notifications,
  close: () => emit('close'),
  editorItem: () => editorItem.value,
  timelineClip: () => timelineClip.value,
  sourceItem: () => sourceItem.value,
  titleText: () => titleText.value,
  editsSingleTimelineClip: () => editsSingleTimelineClip.value,
  editsSavedClipLibrary: () => editsSavedClipLibrary.value,
  hasWarpPitchChanged: () => hasWarpPitchChanged.value,
  sourceBpm: () => sourceBpm.value,
  projectBpm: () => transport.bpm,
  canApplyCrop: () => canApplyCrop.value,
  selectionInMs: () => selectionInMs.value,
  selectionDurationMs: () => selectionDurationMs.value,
  cropViewInMs: () => cropViewInMs.value,
  cropViewDurationMs: () => cropViewDurationMs.value,
  draftSemitones: () => draftSemitones.value,
  draftCents: () => draftCents.value,
  draftTempoEnabled: () => draftTempoEnabled.value,
  draftMode: () => draftMode.value,
  draftTempoPinned: () => draftTempoPinned.value,
  tempoRatioFromPinnedBpm: () => tempoRatioFromPinnedBpm(),
  volumeShapeCommittedPoints: () => volumeShapeCommittedPoints()
})

const { onKeydown, onWindowKeydownCapture } = useClipEditorKeyboard({
  isOpen: () => props.open,
  hasPlaybackSelection: () => hasPlaybackSelection.value,
  close: () => emit('close'),
  clearSelection,
  extendSelection,
  nudgePlayhead,
  togglePlay: onTogglePlay,
  toggleLoop: onToggleLoop,
  zoomIn,
  zoomOut,
  resetZoom,
  undoCropLocal,
  redoCropLocal
})

window.addEventListener('resize', drawWaveform)
onBeforeUnmount(() => window.removeEventListener('resize', drawWaveform))
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-100"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open && editorItem && sourceItem"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clip-editor-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card h-[min(980px,96vh)] w-[min(1440px,98vw)]"
        @keydown="onKeydown"
      >
        <header class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-zinc-800 px-6 py-3">
          <div class="min-w-0 justify-self-start">
            <div class="flex min-w-0 items-center gap-2">
              <h2
                id="clip-editor-title"
                class="truncate text-base font-semibold text-zinc-100"
              >
                {{ titleText }}
              </h2>
              <span
                v-if="warpActive"
                class="shrink-0 rounded border border-white/90 bg-slate-950 px-2 py-0.5 text-[10px] font-bold leading-none tracking-wide text-yellow-300"
                title="This clip is warped"
              >
                WARP
              </span>
            </div>
            <p class="mt-0.5 truncate text-xs text-zinc-500">
              {{ sourceItem.fileName }}
            </p>
          </div>
          <div class="flex items-center gap-1 justify-self-center">
            <button
              type="button"
              data-borderless-button="true"
              class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              title="Skip to start"
              @click="onSkipToStart"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-5 w-5"
              ><path d="M6 5h2v14H6V5zm3 7l11-7v14L9 12z" /></svg>
            </button>
            <button
              type="button"
              data-borderless-button="true"
              class="rounded p-2 hover:bg-blue-600 hover:text-white"
              :class="preview.isPlaying ? 'bg-blue-600 text-white' : 'text-zinc-100'"
              :disabled="!preview.isLoaded"
              :title="!preview.isLoaded ? 'Preparing preview…' : preview.isPlaying ? 'Pause (Space)' : 'Play (Space)'"
              @click="onTogglePlay"
            >
              <svg
                v-if="preview.isPlaying"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-6 w-6"
              ><path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" /></svg>
              <svg
                v-else
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-6 w-6"
              ><path d="M8 5v14l11-7L8 5z" /></svg>
            </button>
            <button
              type="button"
              data-borderless-button="true"
              class="rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              title="Skip to end"
              @click="onSkipToEnd"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-5 w-5"
              ><path d="M16 5h2v14h-2V5zM4 5l11 7-11 7V5z" /></svg>
            </button>
            <button
              type="button"
              data-borderless-button="true"
              class="ml-1 rounded p-2 hover:bg-zinc-800"
              :class="loopEnabled ? 'bg-blue-600 text-white hover:bg-blue-500' : 'text-zinc-300 hover:text-zinc-100'"
              :title="loopEnabled ? 'Loop on (L)' : 'Loop off (L)'"
              @click="onToggleLoop"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                class="h-5 w-5"
              ><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" /></svg>
            </button>
          </div>
          <div class="justify-self-end" />
        </header>

        <div class="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
          <div class="flex min-w-0 flex-col gap-3">
            <canvas
              ref="waveformEl"
              class="h-[min(260px,26vh)] w-full rounded border border-zinc-800 bg-zinc-950"
              :class="volumeEditActive ? 'cursor-pointer' : 'cursor-crosshair'"
              @mousedown="onCanvasMouseDown"
              @contextmenu="onCanvasContextMenu"
              @wheel="onCanvasWheel"
            />
            <div
              class="relative h-2 w-full cursor-pointer rounded bg-zinc-900"
              :title="`Scroll (zoom ${zoomPercent}%)`"
              @mousedown="onScrollbarMouseDown"
            >
              <div
                class="absolute top-0 h-full rounded bg-zinc-600 hover:bg-zinc-500"
                :style="{
                  left: viewDurationMs > 0 ? `${(scrollMs / viewDurationMs) * 100}%` : '0%',
                  width: viewDurationMs > 0
                    ? `${Math.max(2, (visibleDurationMs / viewDurationMs) * 100)}%`
                    : '100%'
                }"
              />
            </div>
            <div class="flex items-center justify-between gap-4 text-xs text-zinc-400">
              <div class="flex min-w-0 items-center gap-6">
                <div>
                  <span class="text-zinc-500">Selection start:</span>
                  <span class="ml-1 font-mono tabular-nums text-zinc-200">{{ formatTime(selectionInMs - viewInMs) }}</span>
                </div>
                <div>
                  <span class="text-zinc-500">Selection end:</span>
                  <span class="ml-1 font-mono tabular-nums text-zinc-200">{{ formatTime(selectionEndMs - viewInMs) }}</span>
                </div>
                <div>
                  <span class="text-zinc-500">Length:</span>
                  <span class="ml-1 font-mono tabular-nums text-zinc-200">{{ formatTime(selectionDurationMs) }}</span>
                </div>
                <div>
                  <span class="text-zinc-500">Playhead:</span>
                  <span class="ml-1 font-mono tabular-nums text-zinc-200">{{ formatTime(playheadAbsMs - viewInMs) }}</span>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <!-- Volume Shape edit toggle: turns the waveform into a gain
                     envelope editor. Single timeline clips only, and only in
                     the cropped Clip view (the envelope axis spans the clip);
                     disabled in Source view. -->
                <button
                  v-if="editsSingleTimelineClip"
                  type="button"
                  class="rounded px-2 py-1 text-[11px] font-medium"
                  :class="
                    volumeEditMode && !viewExpanded
                      ? 'bg-violet-600 text-white hover:bg-violet-500'
                      : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40'
                  "
                  :disabled="viewExpanded"
                  :title="
                    viewExpanded
                      ? 'Switch to the Clip view to shape volume'
                      : volumeEditMode
                        ? 'Volume shaping on — click the waveform to add or drag breakpoints'
                        : 'Shape the clip volume over time on the waveform'
                  "
                  @click="volumeEditMode = !volumeEditMode"
                >
                  Volume
                </button>
                <!-- Non-destructive crop: narrows the working view to the
                     current selection so the user can audition/tweak before
                     committing. Local Ctrl+Z / Ctrl+Y undo/redo while the
                     dialog is open. Closing without Save discards every crop. -->
                <button
                  type="button"
                  class="rounded px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="!canApplyCrop"
                  title="Trim the working view to the selection (Ctrl+Z to undo)"
                  @click="onApplyCrop"
                >
                  Trim
                </button>
                <button
                  v-if="editsExistingClip"
                  type="button"
                  class="rounded px-2 py-1 text-[11px] font-medium"
                  :class="
                    viewExpanded
                      ? 'bg-blue-600 text-white hover:bg-blue-500'
                      : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
                  "
                  :title="
                    viewExpanded
                      ? 'Showing full source — click to crop back to the clip'
                      : 'Show full source so you can extend the clip past its current bounds'
                  "
                  @click="viewExpanded = !viewExpanded"
                >
                  {{ viewExpanded ? 'Clip' : 'Source' }}
                </button>
                <button
                  type="button"
                  class="ml-1 flex h-7 w-7 items-center justify-center rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Zoom out (-)"
                  :disabled="zoom <= 1.0001"
                  @click="zoomOut"
                >
                  <span class="text-base leading-none">−</span>
                </button>
                <button
                  type="button"
                  class="rounded bg-zinc-800 px-2 py-1 font-mono text-[11px] tabular-nums text-zinc-200 hover:bg-zinc-700"
                  title="Reset zoom (0)"
                  @click="resetZoom"
                >
                  {{ zoomPercent }}%
                </button>
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Zoom in (+)"
                  :disabled="zoom >= MAX_ZOOM - 0.01"
                  @click="zoomIn"
                >
                  <span class="text-base leading-none">+</span>
                </button>
              </div>
            </div>
          </div>

          <div
            v-if="editsExistingClip"
            class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded border border-zinc-800 bg-zinc-950/40"
          >
            <!-- Effects rack: a modular grid of plugin-style modules. Each
                 effect spans an integer number of fixed-size base cells, so
                 every module shares one aspect-ratio grid and the rack reads
                 as a tidy rack however the resizable dialog is sized. Scrolls
                 both axes; horizontal scroll reveals further effects. -->
            <div
              class="clip-effects-rack silverdaw-scroll grid min-h-0 min-w-0 flex-1 gap-3 overflow-auto p-3"
              role="group"
              aria-label="Clip effects"
            >
              <ClipEffectModule
                title="Warp"
                :cols="1"
                :rows="2"
              >
                <ClipEditorWarpPanel
                  :draft="warpDraft"
                  :source-bpm="sourceBpm"
                  :project-bpm="transport.bpm"
                />
              </ClipEffectModule>
              <ClipEffectModule
                title="Pitch"
                :cols="1"
                :rows="2"
              >
                <ClipEditorPitchPanel
                  :draft="warpDraft"
                  :source-key="sourceKey"
                />
              </ClipEffectModule>
            </div>
          </div>
        </div>

        <footer class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="emit('close')"
          >
            {{ editsExistingClip ? 'Cancel' : 'Close' }}
          </button>
          <button
            v-if="editsExistingClip"
            type="button"
            class="dialog-btn-primary"
            :disabled="!canSaveChanges"
            :title="editsSavedClipLibrary
              ? 'Save changes to the library and every linked timeline clip'
              : 'Save changes to this timeline clip only'"
            @click="onSaveChanges"
          >
            Save
          </button>
          <button
            v-else
            type="button"
            class="dialog-btn-primary"
            :disabled="!canSaveAsNew"
            @click="onSaveAsNew"
          >
            Save as New Clip
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Effects rack modular grid. Base cells are a FIXED size so every module
   keeps a consistent aspect ratio regardless of how the resizable dialog
   is sized; the rack scrolls (the parent supplies overflow) when modules
   exceed the available space. Two cells tall by default; `column dense`
   packs modules left-to-right and back-fills gaps. */
.clip-effects-rack {
  --cell-w: 17rem; /* 272px */
  --cell-h: 11.5rem; /* 184px */
  grid-template-rows: repeat(2, var(--cell-h));
  grid-auto-columns: var(--cell-w);
  grid-auto-flow: column dense;
  justify-content: start;
  align-content: start;
}

.pitch-range-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
  margin-top: -5px;
}

.pitch-range-input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

.pitch-range-input::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}

.pitch-range-input::-moz-range-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}
</style>


