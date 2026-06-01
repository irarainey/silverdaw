<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { usePreviewStore } from '@/stores/previewStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { useTransportStore } from '@/stores/transportStore'
import { effectiveClipDurationMs, useProjectStore, type Clip } from '@/stores/projectStore'
import { libraryItemSourceBpm, useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { formatTime } from '@/lib/musicTime'
import { effectiveDurationMs, effectiveTempoRatio, isWarpActive } from '@/lib/warp'
import { send as sendBridge } from '@/lib/bridgeService'
import { pickPeaksLod } from '@/lib/peaksLod'
import { useClipEditorTarget } from '@/lib/clipEditor/useClipEditorTarget'
import {
  MAX_ZOOM,
  useClipEditorViewport,
  type CropSnapshot
} from '@/lib/clipEditor/useClipEditorViewport'
import {
  clampNumber,
  currentHasTempoWarp,
  pitchNeedsProcessor,
  useClipEditorWarpDraft
} from '@/lib/clipEditor/useClipEditorWarpDraft'
import { useClipEditorVolumeShapeDraft } from '@/lib/clipEditor/useClipEditorVolumeShapeDraft'
import { envelopeGainAtMs } from '@/lib/envelope'
import {
  hitTestHandle,
  overlayGainToY,
  overlayYToGain,
  sourceMsToVolumeTime,
  volumeTimeToSourceMs
} from '@/lib/clipEditor/volumeOverlay'
import ClipEditorWarpPanel from '@/components/ClipEditorWarpPanel.vue'
import ClipEditorPitchPanel from '@/components/ClipEditorPitchPanel.vue'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import type { ClipWarpMode } from '@shared/bridge-protocol'

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

let lastPreviewLoadKey = ''
let previewWarpUpdateTimer: number | null = null

function clearPreviewWarpUpdateTimer(): void {
  if (previewWarpUpdateTimer === null) return
  window.clearTimeout(previewWarpUpdateTimer)
  previewWarpUpdateTimer = null
}

function sendDraftPreviewWarp(): void {
  previewWarpUpdateTimer = null
  if (!props.open || !editsExistingClip.value || !preview.isLoaded) return
  preview.setWarp({
    warpEnabled: draftProcessorEnabled.value,
    warpMode: draftMode.value,
    tempoRatio: previewTempoRatio() ?? null,
    semitones: clampNumber(draftSemitones.value, -12, 12),
    cents: clampNumber(draftCents.value, -100, 100)
  })
}

function scheduleDraftPreviewWarp(): void {
  if (!props.open || !editsExistingClip.value || !preview.isLoaded) return
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
  if (!props.open || !editsExistingClip.value || !preview.isLoaded) return
  preview.setEnvelope(volumeShapeCommittedPoints())
}
function scheduleDraftPreviewEnvelope(): void {
  if (!props.open || !editsExistingClip.value || !preview.isLoaded) return
  if (previewEnvelopeUpdateTimer !== null) return
  previewEnvelopeUpdateTimer = window.setTimeout(sendDraftPreviewEnvelope, 33)
}

// While the preview is playing, keep the playhead visible on the canvas
// (always-follow, regardless of the main timeline's followPlayback pref).
// Behaviour mirrors the main timeline: scroll forward only, recentre the
// playhead when it crosses past ~75% of the way across the visible window.
let lastFollowMs = 0
function autoFollowPlayhead(): void {
  const fullDur = viewDurationMs.value
  const visDur = visibleDurationMs.value
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

  const phRel = playheadAbsMs.value - viewInMs.value
  const maxScroll = Math.max(0, fullDur - visDur)
  const desired = Math.max(0, Math.min(maxScroll, phRel - visDur / 2))

  // Match useTimelineDrawing: hold scroll if target is behind us (avoids
  // jarring backward teleports), and ease in when ahead.
  if (desired <= scrollMs.value) return
  const gap = desired - scrollMs.value
  if (gap <= 0.5) return
  // In ms-space, playback advances at 1000 ms (source) per 1 s (real).
  // Approach rate = 3× playback; proportional term closes a gap in ~0.2s.
  const approachMsPerSec = 1000 * 3
  const proportionalMsPerSec = gap * 5
  const ratePerSec = Math.max(approachMsPerSec, proportionalMsPerSec)
  const step = Math.min(gap, ratePerSec * dtSec)
  if (step > 0) {
    scrollMs.value = Math.max(0, Math.min(maxScroll, scrollMs.value + step))
  }
}

// When a selection is active, playback is bounded by it. As soon as
// the playhead reaches the selection end, pause and rewind to the
// selection start so the next Play press replays the section.
// Natural end-of-window (the entire preview window finished playing)
// is handled separately via the `endedCount` watcher further below
// — applyEnded resets positionMs to 0, so a position-based check
// here can't detect that transition.
function enforceSelectionPlaybackBounds(): void {
  if (!preview.isPlaying) return

  if (!editorItem.value) return
  const isSavedClip = editsExistingClip.value
  const hasSel = hasPlaybackSelection.value
  // Loop applies whenever there's a selection, OR for a saved clip with
  // no selection (loops the whole clip). Source files only loop when
  // there is an explicit selection.
  const looping = loopEnabled.value && (hasSel || isSavedClip)

  // While playing, enforce the selection bounds before reaching the
  // natural end of the preview window.
  if (!hasSel && !looping) return
  const pos = preview.positionMs
  const endRel = playbackEndMs.value - viewInMs.value
  if (pos < endRel - 0.5) return
  const startRel = Math.max(0, playbackStartMs.value - viewInMs.value)
  if (looping) {
    preview.seek(startRel)
  } else {
    preview.pause()
    preview.seek(startRel)
  }
}

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
      lastHiResRequestKey = ''
      cropUndoStack.value = []
      cropRedoStack.value = []
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
      lastPreviewLoadKey = ''
      library.setEditorHiResPeaks(null)
      lastHiResRequestKey = ''
      cropUndoStack.value = []
      cropRedoStack.value = []
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
    lastPreviewLoadKey = ''
    initSelectionForItem()
    initialiseWarpDraft(timelineClip.value ?? editorItem.value, editsExistingClip.value)
    initialiseVolumeShapeDraft(timelineClip.value, volumeShapeDurationMs.value)
    lastHiResRequestKey = ''
    cropUndoStack.value = []
    cropRedoStack.value = []
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

// True when the keydown originated from a field the user is typing into
// (text input, textarea, select, contenteditable). The dialog's transport
// / zoom / undo shortcuts must NOT fire in that case, or they swallow
// digits ("0" → resetZoom), spaces, and arrow keys mid-edit. Uses the
// composed path so it stays correct regardless of focus drift.
function isEditableTarget(e: Event): boolean {
  const el = (e.composedPath?.()[0] as HTMLElement | null) ?? (e.target as HTMLElement | null)
  if (!el) return false
  if (el.isContentEditable) return true
  return el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null
}

function onWindowKeydownCapture(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.isComposing) return
  if (isEditableTarget(e)) return
  if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    e.stopPropagation()
    if (!e.repeat) onTogglePlay()
    return
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return
  const key = e.key.toLowerCase()
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault()
    e.stopPropagation()
    undoCropLocal()
    return
  }
  if ((key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey)) {
    e.preventDefault()
    e.stopPropagation()
    redoCropLocal()
  }
}

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

// The preview is always loaded for the full clip view (the source range for
// audio-files; the cropped range for saved-clips). The selection is now a
// passive marker indicating what would be saved/applied; the playhead is a
// free cursor anywhere inside the view.
function loadPreviewForView(): void {
  const entry = editorItem.value
  if (!entry) return
  const src = sourceItem.value
  if (!src) return
  // Pass any warp defaults stored on the library item (saved-clips
  // carry the user's preferred warp at the time the clip was saved)
  // so the preview voice plays the clip the way the timeline will.
  // Audio-file items don't carry warp metadata, so the spread is a
  // no-op for them.
  const previewSourceBpm = libraryItemSourceBpm(entry, library.byId)
  const current = timelineClip.value ?? entry
  const tempoRatio = isWarpActive({
    warpEnabled: current.warpEnabled,
    tempoRatio: current.tempoRatio,
    sourceBpm: previewSourceBpm,
    projectBpm: transport.bpm
  })
    ? effectiveTempoRatio({
        tempoRatio: current.tempoRatio,
        sourceBpm: previewSourceBpm,
        projectBpm: transport.bpm
      })
    : current.tempoRatio
  const warp = editsExistingClip.value
    ? {
        warpEnabled: draftProcessorEnabled.value,
        warpMode: draftMode.value,
        tempoRatio: previewTempoRatio(),
        semitones: draftSemitones.value,
        cents: draftCents.value
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
    inMs: viewInMs.value,
    durationMs: viewDurationMs.value,
    warp
  })
  if (loadKey === lastPreviewLoadKey) return
  lastPreviewLoadKey = loadKey
  preview.load(src.id, viewInMs.value, viewDurationMs.value, warp)
}

// On-demand high-resolution peaks for the Clip Editor. The default
// peaks resolution (500 peaks/sec, shared with the timeline) starts
// to look chunky past about 8× zoom; this requests a one-off
// higher-resolution rebuild for the source file that only the editor
// uses, cached on disk by `PeaksCache` so subsequent dialog opens
// for the same source are instant.
const EDITOR_HI_RES_PEAKS_PER_SECOND = 2000
const EDITOR_HI_RES_ZOOM_THRESHOLD = 4
let lastHiResRequestKey = ''

function ensureEditorHiResPeaks(): void {
  const src = sourceItem.value
  if (!src) return
  if (zoom.value < EDITOR_HI_RES_ZOOM_THRESHOLD) return
  const existing = library.editorHiResPeaks
  if (existing && existing.libraryItemId === src.id &&
      existing.peaksPerSecond >= EDITOR_HI_RES_PEAKS_PER_SECOND) {
    return
  }
  const key = `${src.id}:${EDITOR_HI_RES_PEAKS_PER_SECOND}`
  if (key === lastHiResRequestKey) return
  lastHiResRequestKey = key
  sendBridge('CLIP_EDITOR_PEAKS_REQUEST', {
    libraryItemId: src.id,
    peaksPerSecond: EDITOR_HI_RES_PEAKS_PER_SECOND
  })
}

// Trigger a request whenever the user zooms in past the threshold.
watch(zoom, () => ensureEditorHiResPeaks())

function drawWaveform(): void {
  const canvas = waveformEl.value
  if (!canvas) return
  const src = sourceItem.value
  if (!src) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const w = Math.max(1, Math.floor(rect.width * dpr))
  const h = Math.max(1, Math.floor(rect.height * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h

  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#0a0a0a'
  ctx.fillRect(0, 0, w, h)

  const sourceTotal = sourceDurationMs.value
  const vIn = visibleInMs.value
  const vDur = visibleDurationMs.value
  const vEnd = visibleEndMs.value
  if (vDur <= 0) return

  // Map an ms value (in source coords) to canvas x.
  const msToX = (ms: number): number => ((ms - vIn) / vDur) * w

  // Layout: ruler band on top, waveform underneath.
  const rulerH = Math.round(18 * dpr)
  const waveTop = rulerH
  const waveH = h - rulerH
  const waveMid = waveTop + waveH / 2

  // --- Ruler band -------------------------------------------------------
  ctx.fillStyle = '#18181b'
  ctx.fillRect(0, 0, w, rulerH)
  ctx.strokeStyle = '#27272a'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, rulerH - 0.5)
  ctx.lineTo(w, rulerH - 0.5)
  ctx.stroke()

  // Adaptive tick spacing: aim for ~80px between major ticks.
  const targetPx = 80 * dpr
  const msPerPx = vDur / w
  const niceSteps: number[] = [
    50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000,
    120_000, 300_000, 600_000
  ]
  const desiredStep = targetPx * msPerPx
  let majorMs = niceSteps[niceSteps.length - 1] ?? 1000
  for (const s of niceSteps) {
    if (s >= desiredStep) {
      majorMs = s
      break
    }
  }
  const minorMs = majorMs / 5
  const firstMinor = Math.ceil(vIn / minorMs) * minorMs
  ctx.strokeStyle = '#3f3f46'
  ctx.fillStyle = '#a1a1aa'
  ctx.font = `${Math.round(10 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  ctx.textBaseline = 'top'
  for (let t = firstMinor; t <= vEnd + 0.0001; t += minorMs) {
    const x = Math.round(msToX(t)) + 0.5
    const isMajor = Math.abs(t / majorMs - Math.round(t / majorMs)) < 1e-6
    const tickH = isMajor ? Math.round(8 * dpr) : Math.round(4 * dpr)
    ctx.beginPath()
    ctx.moveTo(x, rulerH - tickH)
    ctx.lineTo(x, rulerH)
    ctx.stroke()
    if (isMajor) {
      // Label times relative to the visible clip start (viewInMs).
      const label = formatRulerTime(t - viewInMs.value, majorMs)
      ctx.fillText(label, x + 3 * dpr, 2 * dpr)
    }
  }

  // --- Waveform centre baseline ----------------------------------------
  ctx.strokeStyle = '#27272a'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, waveMid)
  ctx.lineTo(w, waveMid)
  ctx.stroke()

  // --- Waveform peaks --------------------------------------------------
  // The editor has three potential peak sources, in order of preference:
  //   1. editorHiResPeaks — backend-rebuilt 2000 ppS rendering requested
  //      on demand when the user zooms in past EDITOR_HI_RES_ZOOM_THRESHOLD.
  //   2. The library item's LOD pyramid — picked by current px/sec so
  //      zoomed-out views walk a coarser level instead of millions of
  //      base peaks per redraw.
  //   3. The library item's base peaks (`src.peaks`) as a fallback.
  // The picker uses the same hysteresis as the main timeline so zoom
  // drags don't flicker between adjacent levels.
  const hiRes = library.editorHiResPeaks
  const usingHiRes = hiRes && hiRes.libraryItemId === src.id && hiRes.peaks.length >= 2
  // Convert visible-ms-per-canvas-pixel into px-per-source-second so the
  // LOD picker speaks the same units as the main timeline.
  const canvasPxPerSourceSec = vDur > 0 ? (w / vDur) * 1000 : 0
  let peaks: Float32Array
  let peaksPerSec: number
  if (usingHiRes) {
    peaks = hiRes!.peaks
    peaksPerSec = hiRes!.peaksPerSecond
  } else if (src.peaksLod && src.peaksLod.length > 0 && canvasPxPerSourceSec > 0) {
    const picked = pickPeaksLod(src.peaksLod, canvasPxPerSourceSec)
    peaks = picked.peaks
    peaksPerSec = picked.peaksPerSecond
  } else {
    peaks = src.peaks
    peaksPerSec = src.peaksPerSecond ?? 0
  }
  if (peaks && peaks.length >= 2 && sourceTotal > 0) {
    const pairs = Math.floor(peaks.length / 2)
    // Map each canvas column to a peak index. When the LOD's actual
    // ppS is known, use it for a sample-accurate mapping (so transients
    // do not drift against the ruler/beat grid). Otherwise fall back
    // to the legacy proportional mapping over `sourceTotal`.
    const useRate = peaksPerSec > 0
    const peakStart = useRate
      ? (vIn / 1000) * peaksPerSec
      : (vIn / sourceTotal) * pairs
    const peakSpan = useRate
      ? (vDur / 1000) * peaksPerSec
      : (vDur / sourceTotal) * pairs
    ctx.fillStyle = '#3b82f6'
    for (let x = 0; x < w; x++) {
      const i = Math.floor(peakStart + (x / w) * peakSpan)
      if (i < 0 || i >= pairs) continue
      const lo = peaks[i * 2] || 0
      const hi = peaks[i * 2 + 1] || 0
      const y0 = waveMid - hi * (waveH / 2)
      const y1 = waveMid - lo * (waveH / 2)
      ctx.fillRect(x, Math.min(y0, y1), 1, Math.max(1, Math.abs(y1 - y0)))
    }
  }

  // --- Beat lines (extrapolated uniformly across the full source so the
  // whole track has beats, not just the detected window). Uses BPM +
  // beatAnchorSec the same way the main timeline does. ----------------
  const sourceBpm = src.bpm
  const anchorSec = src.beatAnchorSec ?? src.beats?.[0]
  if (sourceBpm && sourceBpm > 0 && anchorSec !== undefined) {
    const beatSpacingMs = (60 / sourceBpm) * 1000
    const anchorMs = anchorSec * 1000
    if (beatSpacingMs > 0) {
      // Step the grid through the *visible* window only — we still iterate
      // beats across the whole source conceptually, but only draw those
      // that fall inside [vIn, vEnd].
      let firstBeatMs =
        anchorMs + Math.ceil((vIn - anchorMs) / beatSpacingMs) * beatSpacingMs
      while (firstBeatMs < vIn) firstBeatMs += beatSpacingMs
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)'
      ctx.lineWidth = 1
      ctx.beginPath()
      const minPxSpacing = 4 * dpr
      let lastX = Number.NEGATIVE_INFINITY
      for (let beatMs = firstBeatMs; beatMs <= vEnd + 0.5; beatMs += beatSpacingMs) {
        const x = Math.round(msToX(beatMs)) + 0.5
        if (x - lastX < minPxSpacing) continue
        ctx.moveTo(x, waveTop)
        ctx.lineTo(x, h)
        lastX = x
      }
      ctx.stroke()
    }
  }

  // --- Selection overlay -----------------------------------------------
  // Source-file editing always shows handles; existing clips show handles only after
  // the user has narrowed the selection inside the cropped view.
  const fullVIn = viewInMs.value
  const fullVEnd = viewEndMs.value
  const isSubSelection =
    selectionInMs.value > fullVIn + 0.5 || selectionEndMs.value < fullVEnd - 0.5
  const showHandles = !editsExistingClip.value || isSubSelection
  if (selectionDurationMs.value > 0 && showHandles) {
    const sx = msToX(selectionInMs.value)
    const ex = msToX(selectionEndMs.value)
    ctx.fillStyle = 'rgba(59, 130, 246, 0.18)'
    ctx.fillRect(sx, waveTop, ex - sx, waveH)
    ctx.fillStyle = '#3b82f6'
    ctx.fillRect(sx - 1, 0, 2, h)
    ctx.fillRect(ex - 1, 0, 2, h)
    // Triangle grab handles at the top and bottom of each edge line.
    // Pointing inward toward the selection so the visual reads as
    // "here's where the selection edge is — grab to fine-tune". Hit
    // detection on these lives in `onCanvasMouseDown` (HANDLE_PX
    // around the edge x) so the user can also click the line itself.
    const handleW = 10 * dpr
    const handleH = 8 * dpr
    // Start edge — triangles point right (into the selection).
    ctx.beginPath()
    ctx.moveTo(sx, 0)
    ctx.lineTo(sx + handleW, 0)
    ctx.lineTo(sx, handleH)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(sx, h)
    ctx.lineTo(sx + handleW, h)
    ctx.lineTo(sx, h - handleH)
    ctx.closePath()
    ctx.fill()
    // End edge — triangles point left (into the selection).
    ctx.beginPath()
    ctx.moveTo(ex, 0)
    ctx.lineTo(ex - handleW, 0)
    ctx.lineTo(ex, handleH)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(ex, h)
    ctx.lineTo(ex - handleW, h)
    ctx.lineTo(ex, h - handleH)
    ctx.closePath()
    ctx.fill()
  }

  // --- Playhead --------------------------------------------------------
  const px = msToX(playheadAbsMs.value)
  if (px >= 0 && px <= w) {
    ctx.strokeStyle = '#f97316'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, h)
    ctx.stroke()
  }

  // --- Volume Shape (gain envelope) overlay ----------------------------
  // Drawn directly over the waveform so it's obvious which part of the clip
  // each breakpoint affects. Editable in place when Volume mode is on (see
  // `volumeEditActive`); otherwise rendered faint as read-only context.
  // Only shown in the cropped Clip view, where the breakpoint time axis
  // (clip-local post-warp ms) spans the whole clip from its source start.
  if (volumeShapeAvailable.value) {
    const points = volumeShapeDraft.draftPoints.value
    const editing = volumeEditActive.value
    // The volume line is always visible as context; the Volume toggle only
    // controls whether it's editable (brighter line + grabbable handles).
    if (points.length >= 2) {
      const ratio = warpDraft.draftEffectiveRatio.value > 0 ? warpDraft.draftEffectiveRatio.value : 1
      const clipStartSourceMs = viewInMs.value
      const durMs = volumeShapeDurationMs.value
      const envX = (timelineMs: number): number =>
        msToX(volumeTimeToSourceMs(timelineMs, clipStartSourceMs, ratio))
      const envY = (gain: number): number => overlayGainToY(gain, waveTop, waveH)

      // Unity (0 dB) reference line across the clip span.
      const xStart = envX(0)
      const xEnd = envX(durMs)
      ctx.strokeStyle = 'rgba(63, 63, 70, 0.9)'
      ctx.lineWidth = 1
      ctx.setLineDash([3 * dpr, 3 * dpr])
      ctx.beginPath()
      const uy = envY(1)
      ctx.moveTo(xStart, uy)
      ctx.lineTo(xEnd, uy)
      ctx.stroke()
      ctx.setLineDash([])

      // Sampled curve (linear-in-dB segments are curved in linear gain).
      const steps = Math.max(16, Math.round((xEnd - xStart) / (3 * dpr)))
      ctx.strokeStyle = editing ? 'rgba(167, 139, 250, 0.95)' : 'rgba(167, 139, 250, 0.5)'
      ctx.lineWidth = editing ? 2 * dpr : 1.5 * dpr
      ctx.beginPath()
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * durMs
        const x = envX(t)
        const y = envY(envelopeGainAtMs(points, t))
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Breakpoint handles. Brighter and larger when editing.
      const r = (editing ? 4 : 2.5) * dpr
      for (let i = 0; i < points.length; i++) {
        const p = points[i]
        if (!p) continue
        const x = envX(p.timeMs)
        const y = envY(p.gain)
        const isEndpoint = i === 0 || i === points.length - 1
        ctx.fillStyle = editing
          ? isEndpoint
            ? '#8b5cf6'
            : '#c4b5fd'
          : 'rgba(196, 181, 253, 0.6)'
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        if (editing) {
          ctx.strokeStyle = '#2e1065'
          ctx.lineWidth = 1 * dpr
          ctx.stroke()
        }
      }
    }
  }
}

function formatRulerTime(ms: number, stepMs: number): string {
  const totalSec = ms / 1000
  if (stepMs < 1000) {
    // Show fractional seconds when ticks are sub-second.
    const decimals = stepMs < 100 ? 2 : 1
    return totalSec.toFixed(decimals) + 's'
  }
  const sign = totalSec < 0 ? '-' : ''
  const t = Math.abs(totalSec)
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${sign}${m}:${s.toString().padStart(2, '0')}`
}

function onCanvasMouseDown(e: MouseEvent): void {
  const canvas = waveformEl.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const vIn = visibleInMs.value
  const vDur = visibleDurationMs.value
  // Drag/click still clamps to the full clip bounds, not the visible window —
  // a user can drag past the canvas edge to keep extending the selection.
  const fullIn = viewInMs.value
  const fullEnd = viewEndMs.value
  if (vDur <= 0) return

  // Volume edit mode hijacks the canvas pointer to edit the gain envelope
  // instead of the selection. Handled first so none of the selection logic
  // below runs while shaping volume.
  if (volumeEditActive.value) {
    onCanvasEnvelopePointerDown(e, rect, vIn, vDur)
    return
  }

  const xToMs = (clientX: number): number =>
    Math.max(fullIn, Math.min(fullEnd, vIn + ((clientX - rect.left) / rect.width) * vDur))
  const startSx = ((selectionInMs.value - vIn) / vDur) * rect.width
  const endSx = ((selectionEndMs.value - vIn) / vDur) * rect.width
  const localX = e.clientX - rect.left
  const startX = e.clientX
  const HANDLE_PX = 12

  // Handle grabs only count when there's actually a visible sub-selection.
  // The hit zone is intentionally wider than the 1-px edge line so the
  // triangle grab markers drawn at the top/bottom of each edge fall
  // inside the grabbable area.
  const hasSubSel = selectionInMs.value > fullIn + 0.5 || selectionEndMs.value < fullEnd - 0.5
  let mode: 'start' | 'end' | 'select' | 'click' = 'click'
  if (hasSubSel && Math.abs(localX - startSx) <= HANDLE_PX) mode = 'start'
  else if (hasSubSel && Math.abs(localX - endSx) <= HANDLE_PX) mode = 'end'

  const anchorMs = xToMs(e.clientX)

  const onMove = (ev: MouseEvent): void => {
    const ms = xToMs(ev.clientX)
    if (mode === 'click') {
      // Promote to a drag-select only once the user actually moves the mouse.
      if (Math.abs(ev.clientX - startX) > 3) mode = 'select'
      else return
    }
    if (mode === 'start') {
      const next = Math.min(ms, selectionEndMs.value - 50)
      const delta = next - selectionInMs.value
      selectionInMs.value = Math.max(fullIn, next)
      selectionDurationMs.value = Math.max(50, selectionDurationMs.value - delta)
    } else if (mode === 'end') {
      const next = Math.min(fullEnd, Math.max(ms, selectionInMs.value + 50))
      selectionDurationMs.value = Math.max(50, next - selectionInMs.value)
    } else if (mode === 'select') {
      const lo = Math.max(fullIn, Math.min(anchorMs, ms))
      const hi = Math.min(fullEnd, Math.max(anchorMs, ms))
      selectionInMs.value = lo
      selectionDurationMs.value = Math.max(50, hi - lo)
    }
  }
  const onUp = (ev: MouseEvent): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (mode === 'click') {
      const ms = xToMs(ev.clientX)
      // Click outside the current narrowing selection clears it AND
      // moves the playhead. Click inside the selection just moves the
      // playhead (so the user can scrub within their selection).
      if (
        hasPlaybackSelection.value &&
        (ms < selectionInMs.value || ms > selectionEndMs.value)
      ) {
        clearSelection()
      }
      seekPlayheadToSourceMs(ms)
    }
    // Selection changes don't reload the preview — preview window is the
    // whole clip view, so the playhead stays valid as the selection moves.
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// Envelope editing on the waveform canvas. Mirrors the SVG editor's gestures
// (drag a handle to move it, click the curve to add a breakpoint then drag,
// Alt-click / right-click a handle to remove it) but in the canvas's own
// pixel space. All coordinates here are CSS pixels (getBoundingClientRect),
// whereas `drawWaveform` works in device pixels — both map gain/time the
// same way via the shared `volumeOverlay` helpers, just with a different
// height/ruler scale.
function onCanvasEnvelopePointerDown(
  e: MouseEvent,
  rect: DOMRect,
  vIn: number,
  vDur: number
): void {
  const ratio = warpDraft.draftEffectiveRatio.value > 0 ? warpDraft.draftEffectiveRatio.value : 1
  const clipStartSourceMs = viewInMs.value
  const durMs = volumeShapeDurationMs.value
  const rulerCss = 18
  const waveTopCss = rulerCss
  const waveHCss = Math.max(1, rect.height - rulerCss)

  const timeToXCss = (timelineMs: number): number => {
    const sourceMs = volumeTimeToSourceMs(timelineMs, clipStartSourceMs, ratio)
    return ((sourceMs - vIn) / vDur) * rect.width
  }
  const xToTime = (clientX: number): number => {
    const sourceMs = vIn + ((clientX - rect.left) / rect.width) * vDur
    return Math.max(0, Math.min(durMs, sourceMsToVolumeTime(sourceMs, clipStartSourceMs, ratio)))
  }
  const yToGain = (clientY: number): number =>
    overlayYToGain(clientY - rect.top, waveTopCss, waveHCss)

  const lx = e.clientX - rect.left
  const ly = e.clientY - rect.top
  const points = volumeShapeDraft.draftPoints.value
  const positions = points.map((p) => ({
    x: timeToXCss(p.timeMs),
    y: overlayGainToY(p.gain, waveTopCss, waveHCss)
  }))
  const hit = hitTestHandle(positions, lx, ly, 12)

  // Alt-click or right-click on a handle removes it (endpoints are pinned
  // and protected inside `removePoint`).
  if (hit !== null && (e.altKey || e.button === 2)) {
    volumeShapeDraft.removePoint(hit)
    return
  }
  // Right-click on empty space does nothing (the context menu is suppressed).
  if (e.button === 2) return

  let dragIndex = hit
  if (dragIndex === null) {
    dragIndex = volumeShapeDraft.addPoint(xToTime(e.clientX), yToGain(e.clientY))
  }
  e.preventDefault()

  const onMove = (ev: MouseEvent): void => {
    if (dragIndex === null) return
    volumeShapeDraft.movePoint(dragIndex, xToTime(ev.clientX), yToGain(ev.clientY))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// Suppress the browser context menu over the canvas while shaping volume so
// right-click can delete a breakpoint instead.
function onCanvasContextMenu(e: MouseEvent): void {
  if (volumeEditActive.value) e.preventDefault()
}

function seekPlayheadToSourceMs(sourceMs: number): void {
  const fullIn = viewInMs.value
  const fullDur = viewDurationMs.value
  if (fullDur <= 0) return
  const rel = Math.max(0, Math.min(fullDur, sourceMs - fullIn))
  preview.seek(rel)
}

const SMALLEST_NUDGE_MS = 1

// Step forward or backward from a given source-ms position. When
// `snapToBeats` is true, jumps to the next/prev beat on the extrapolated
// grid (BPM + anchor). Otherwise nudges by 1 ms. Result is clamped to
// the clip view bounds.
function stepMsFrom(fromMs: number, direction: -1 | 1, snapToBeats: boolean): number {
  const fullIn = viewInMs.value
  const fullEnd = viewEndMs.value
  if (!snapToBeats) {
    return Math.max(fullIn, Math.min(fullEnd, fromMs + direction * SMALLEST_NUDGE_MS))
  }
  const src = sourceItem.value
  const sourceBpm = src?.bpm
  const anchorSec = src?.beatAnchorSec ?? src?.beats?.[0]
  if (!sourceBpm || sourceBpm <= 0 || anchorSec === undefined) {
    return Math.max(fullIn, Math.min(fullEnd, fromMs + direction * SMALLEST_NUDGE_MS))
  }
  const beatSpacingMs = (60 / sourceBpm) * 1000
  const anchorMs = anchorSec * 1000
  const epsilon = 1
  const beatsFromAnchor = (fromMs - anchorMs) / beatSpacingMs
  const nextIdx =
    direction > 0
      ? Math.floor(beatsFromAnchor + epsilon / beatSpacingMs) + 1
      : Math.ceil(beatsFromAnchor - epsilon / beatSpacingMs) - 1
  const targetAbs = anchorMs + nextIdx * beatSpacingMs
  return Math.max(fullIn, Math.min(fullEnd, targetAbs))
}

function nudgePlayhead(direction: -1 | 1, snapToBeats: boolean): void {
  const fullDur = viewDurationMs.value
  if (fullDur <= 0) return
  seekPlayheadToSourceMs(stepMsFrom(playheadAbsMs.value, direction, snapToBeats))
}

// Shift+Arrow extends the selection from the playhead position. With
// Alt held, extension is in 1-ms increments; otherwise it snaps to
// beats. Works for both audio-file (start a new selection) and
// saved-clip (narrow the existing window).
function extendSelection(direction: -1 | 1, snapToBeats: boolean): void {
  const fullDur = viewDurationMs.value
  if (fullDur <= 0) return
  const ph = playheadAbsMs.value
  const hasSel = hasPlaybackSelection.value
  let newEdge: number
  if (!hasSel) {
    // Anchor the new selection at the playhead.
    if (direction > 0) {
      const end = stepMsFrom(ph, 1, snapToBeats)
      selectionInMs.value = ph
      selectionDurationMs.value = Math.max(SMALLEST_NUDGE_MS, end - ph)
      newEdge = end
    } else {
      const start = stepMsFrom(ph, -1, snapToBeats)
      selectionInMs.value = start
      selectionDurationMs.value = Math.max(SMALLEST_NUDGE_MS, ph - start)
      newEdge = start
    }
  } else if (direction > 0) {
    newEdge = stepMsFrom(selectionEndMs.value, 1, snapToBeats)
    selectionDurationMs.value = Math.max(SMALLEST_NUDGE_MS, newEdge - selectionInMs.value)
  } else {
    newEdge = stepMsFrom(selectionInMs.value, -1, snapToBeats)
    const delta = newEdge - selectionInMs.value
    selectionInMs.value = newEdge
    selectionDurationMs.value = Math.max(SMALLEST_NUDGE_MS, selectionDurationMs.value - delta)
  }
  // Move the playhead to the new edge so the user sees the change.
  seekPlayheadToSourceMs(newEdge)
}

function onCanvasWheel(e: WheelEvent): void {
  const canvas = waveformEl.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const vIn = visibleInMs.value
  const vDur = visibleDurationMs.value
  if (vDur <= 0) return
  // Shift+wheel or any horizontal wheel delta → pan; otherwise → zoom anchored at cursor.
  const pan = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)
  e.preventDefault()
  if (pan) {
    const dx = (e.shiftKey ? e.deltaY : e.deltaX) || e.deltaY
    const msPerPx = vDur / rect.width
    const next = scrollMs.value + dx * msPerPx
    scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, next))
  } else {
    const pointerMs = vIn + ((e.clientX - rect.left) / rect.width) * vDur
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
    setZoomAnchored(zoom.value * factor, pointerMs)
  }
}

function onScrollbarMouseDown(e: MouseEvent): void {
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const vDur = viewDurationMs.value
  if (vDur <= 0) return
  const visDur = visibleDurationMs.value
  const thumbWidth = (visDur / vDur) * rect.width
  // If user clicks on the thumb start it as a drag, else jump-to-here then drag.
  const initialThumbLeft = (scrollMs.value / vDur) * rect.width
  const clickInThumb =
    e.clientX - rect.left >= initialThumbLeft &&
    e.clientX - rect.left <= initialThumbLeft + thumbWidth
  if (!clickInThumb) {
    const targetLeft = e.clientX - rect.left - thumbWidth / 2
    scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, (targetLeft / rect.width) * vDur))
  }
  const grabOffsetMs = (e.clientX - rect.left) / rect.width * vDur - scrollMs.value
  const onMove = (ev: MouseEvent): void => {
    const ms = (ev.clientX - rect.left) / rect.width * vDur - grabOffsetMs
    scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, ms))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

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

// Clear the user-narrowing selection so playback (and Save-as-new /
// Apply-trim gating) revert to whole-view semantics.
function clearSelection(): void {
  selectionInMs.value = viewInMs.value
  selectionDurationMs.value = viewDurationMs.value
}

function onKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  const editable = isEditableTarget(e)
  if (e.key === 'Escape') {
    // While typing in a field, Esc cancels the field focus rather than
    // closing the whole dialog (and never traps the user).
    if (editable) {
      ;(e.target as HTMLElement | null)?.blur()
      return
    }
    // Esc with an active selection clears the selection first; a
    // second Esc closes the dialog. Matches how text-editor and DAW
    // selections behave.
    if (hasPlaybackSelection.value) {
      e.preventDefault()
      clearSelection()
      return
    }
    emit('close')
    return
  }
  // No other transport / zoom / undo shortcut should fire while the
  // user is typing into an input — otherwise digits ("0"), spaces and
  // arrow keys get hijacked mid-edit.
  if (editable) return
  if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D') && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    clearSelection()
    return
  }
  // Dialog-local Undo / Redo: only covers the Crop button's
  // working-view changes. The global undo handler defers to the
  // dialog while `ui.clipEditorOpen` is true, so these shortcuts
  // never leak through to the project-wide undo stack.
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const key = e.key.toLowerCase()
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault()
      undoCropLocal()
      return
    }
    if ((key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey)) {
      e.preventDefault()
      redoCropLocal()
      return
    }
  }
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault()
    e.stopPropagation()
    onTogglePlay()
    return
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    if (e.shiftKey) extendSelection(-1, !e.altKey)
    else nudgePlayhead(-1, !e.altKey)
    return
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    if (e.shiftKey) extendSelection(1, !e.altKey)
    else nudgePlayhead(1, !e.altKey)
    return
  }
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    zoomIn()
    return
  }
  if (e.key === '-' || e.key === '_') {
    e.preventDefault()
    zoomOut()
    return
  }
  if (e.key === '0') {
    e.preventDefault()
    resetZoom()
    return
  }
  if (e.key === 'l' || e.key === 'L') {
    e.preventDefault()
    onToggleLoop()
  }
}

// Dialog-local undo stack for Crop operations. Crop is purely
// non-destructive (it just narrows the working view); committing the
// final result via Apply trim goes through the project-wide
// UndoManager and gets its own undo step there. We keep this stack
// scoped to the dialog so closing it discards any uncommitted crops
// — the library entry hasn't been touched.
const cropUndoStack = ref<CropSnapshot[]>([])
const cropRedoStack = ref<CropSnapshot[]>([])

function captureCropSnapshot(): CropSnapshot {
  return viewport.captureCropSnapshot()
}

function restoreCropSnapshot(snap: CropSnapshot): void {
  viewport.restoreCropSnapshot(snap)
  drawWaveform()
  loadPreviewForView()
}

function onApplyCrop(): void {
  if (!canApplyCrop.value) return
  cropUndoStack.value.push(captureCropSnapshot())
  cropRedoStack.value = []
  cropViewInMs.value = Math.max(0, selectionInMs.value)
  cropViewDurationMs.value = Math.max(0, selectionDurationMs.value)
  resetZoom()
  drawWaveform()
  loadPreviewForView()
}

function undoCropLocal(): void {
  const snap = cropUndoStack.value.pop()
  if (!snap) return
  cropRedoStack.value.push(captureCropSnapshot())
  restoreCropSnapshot(snap)
}

function redoCropLocal(): void {
  const snap = cropRedoStack.value.pop()
  if (!snap) return
  cropUndoStack.value.push(captureCropSnapshot())
  restoreCropSnapshot(snap)
}

function savedClipWarpPatch(): {
  warpEnabled: boolean
  warpMode: ClipWarpMode
  tempoRatio: number | null
  semitones: number
  cents: number
} {
  const nextSemitones = clampNumber(draftSemitones.value, -12, 12)
  const nextCents = clampNumber(draftCents.value, -100, 100)
  const pitchActive = pitchNeedsProcessor(nextSemitones, nextCents)
  return {
    warpEnabled: draftTempoEnabled.value || pitchActive,
    warpMode: draftMode.value,
    tempoRatio: draftTempoEnabled.value
      ? (draftTempoPinned.value ? tempoRatioFromPinnedBpm() ?? null : null)
      : (pitchActive ? 1 : null),
    semitones: nextSemitones,
    cents: nextCents
  }
}

function draftTargetWindow(): { inMs: number; durationMs: number } {
  return {
    inMs:
      canApplyCrop.value || selectionDurationMs.value > 0
        ? selectionInMs.value
        : cropViewInMs.value,
    durationMs:
      canApplyCrop.value || selectionDurationMs.value > 0
        ? selectionDurationMs.value
        : cropViewDurationMs.value
  }
}

function conflictingTrackNameForTimelineClip(clip: Clip, nextDurationMs: number, tempoRatio: number | null): string | null {
  const track = project.tracks.find((candidate) => candidate.id === clip.trackId)
  if (!track) return null
  const effectiveMs = effectiveDurationMs(nextDurationMs, {
    warpEnabled: draftTempoEnabled.value,
    tempoRatio: tempoRatio ?? undefined,
    sourceBpm: sourceBpm.value,
    projectBpm: transport.bpm
  })
  const nextStart = clip.startMs
  const nextEnd = nextStart + effectiveMs
  for (const otherId of track.clipIds) {
    if (otherId === clip.id) continue
    const other = project.clips[otherId]
    if (!other) continue
    const otherEnd = other.startMs + effectiveClipDurationMs(other)
    if (nextStart < otherEnd && nextEnd > other.startMs) return track.name
  }
  return null
}

function onSaveChanges(): void {
  const entry = editorItem.value
  if (!entry) return
  // Save commits the whole Clip Editor draft atomically. Until this
  // point, trim/crop/warp/pitch only affect the local view and preview
  // voice; timeline clips and library items remain untouched.
  const { inMs: targetIn, durationMs: targetDur } = draftTargetWindow()
  const warpPatch = savedClipWarpPatch()
  if (editsSingleTimelineClip.value) {
    const clip = timelineClip.value
    if (!clip) {
      notifications.pushError('Cannot save changes — clip is no longer available.')
      return
    }
    const conflictTrack = conflictingTrackNameForTimelineClip(clip, targetDur, warpPatch.tempoRatio)
    if (conflictTrack) {
      notifications.pushError(`Cannot save changes — they would overlap clips on ${conflictTrack}.`)
      return
    }
    project.trimClip(clip.id, clip.startMs, targetIn, targetDur)
    project.setClipWarp(clip.id, warpPatch)
    // Volume shape is stored in clip-local timeline-ms basis; a flat unity
    // draft commits as an empty array, clearing it.
    project.setClipEnvelope(clip.id, volumeShapeCommittedPoints())
    notifications.pushInfo(`Saved changes for "${titleText.value}".`)
    emit('close')
    return
  }
  if (!editsSavedClipLibrary.value) return
  const result = library.updateSavedClipEdit(entry.id, {
    inMs: targetIn,
    durationMs: targetDur,
    ...warpPatch
  })
  if (result.ok) {
    notifications.pushInfo(`Saved changes for "${titleText.value}".`)
    emit('close')
  } else if (result.conflictingTrackNames && result.conflictingTrackNames.length > 0) {
    notifications.pushError(
      `Cannot save changes — they would overlap clips on ${result.conflictingTrackNames.join(', ')}.`
    )
  } else {
    notifications.pushError('Cannot save changes — invalid edit.')
  }
}

function onSaveAsNew(): void {
  const src = sourceItem.value
  if (!src) return
  const id = library.addSavedClipFromSelection(
    src.id,
    selectionInMs.value,
    selectionDurationMs.value
  )
  if (id) {
    notifications.pushInfo(`Saved selection as new clip.`)
    emit('close')
  }
}

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
