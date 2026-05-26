<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePreviewStore } from '@/stores/previewStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { useTransportStore } from '@/stores/transportStore'
import { libraryItemDisplayName, libraryItemSourceBpm, useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { formatTime } from '@/lib/musicTime'
import { effectiveTempoRatio, isWarpActive } from '@/lib/warp'
import { send as sendBridge } from '@/lib/bridgeService'

const props = defineProps<{
  open: boolean
  item: LibraryItem | null
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const preview = usePreviewStore()
const library = useLibraryStore()
const notifications = useNotificationsStore()
const ui = useUiStore()
const transport = useTransportStore()

const dialogEl = ref<HTMLDivElement | null>(null)
const waveformEl = ref<HTMLCanvasElement | null>(null)

// The source file we always show. For audio-file items this is the item
// itself; for saved-clip items it's the parent audio-file. Selection
// markers are positioned within this source.
const sourceItem = computed<LibraryItem | null>(() => {
  const item = props.item
  if (!item) return null
  if (item.kind === 'saved-clip' && item.derivedFrom?.sourceItemId) {
    return library.items.find((i) => i.id === item.derivedFrom?.sourceItemId) ?? item
  }
  return item
})

const sourceDurationMs = computed(() => sourceItem.value?.durationMs ?? 0)
const warpActive = computed(() => {
  const item = props.item
  if (!item) return false
  return isWarpActive({
    warpEnabled: item.warpEnabled,
    tempoRatio: item.tempoRatio,
    sourceBpm: libraryItemSourceBpm(item, library.items),
    projectBpm: transport.bpm
  })
})

// The Clip Editor opens with the visible *view bounds* limited to the
// clip's window so the user isn't presented with the full source for a
// small clip. `viewExpanded` lifts that limit to expose the full source
// — needed when the user wants to EXTEND (not just crop) a saved
// clip's window. The selection stays where it was, so the existing
// edge handles can simply be dragged outward to grow the saved clip.
const viewExpanded = ref(false)

// The cropped-view bounds for saved-clips. Starts at the persisted
// `derivedFrom` window but can be updated mid-edit — specifically
// when the user expands to Source view, grows the selection to a
// bigger range, and toggles back: the cropped view snaps to the new
// selection so the canvas shows that range zoomed in for fine
// tuning. Persistence still lives on the library item; the user
// commits via "Apply trim".
const cropViewInMs = ref(0)
const cropViewDurationMs = ref(0)

// Visible window on the canvas, in ms relative to the source.
// - audio-file: always the full source.
// - saved-clip: the cropped-view bounds by default; full source when
//   `viewExpanded` is true.
const viewInMs = computed(() => {
  const item = props.item
  if (!item) return 0
  if (item.kind === 'saved-clip' && !viewExpanded.value) return cropViewInMs.value
  return 0
})
const viewDurationMs = computed(() => {
  const item = props.item
  if (!item) return 0
  if (item.kind === 'saved-clip' && !viewExpanded.value) {
    return cropViewDurationMs.value
  }
  return sourceDurationMs.value
})
const viewEndMs = computed(() => viewInMs.value + viewDurationMs.value)

// Zoom is expressed as a multiplier of a per-item "base scale".
//
// - audio-file (full source): the base scale matches the main timeline's
//   pixels-per-second (`ui.zoomPxPerSecond`). zoom=1 → identical scale to
//   the timeline. The canvas only shows a window of the source; the user
//   scrolls horizontally to see the rest.
// - saved-clip: the base scale is whatever fits the cropped clip range
//   exactly into the canvas. zoom=1 → entire clip visible.
//
// Both cases cap at 64× (6400%) and never zoom out below 1× (the base scale
// for that item).
const MIN_ZOOM = 1
const MAX_ZOOM = 64
const zoom = ref(1)
const scrollMs = ref(0)
const canvasCssWidth = ref(0)

const basePxPerMs = computed(() => {
  const item = props.item
  if (!item) return 0
  if (item.kind === 'audio-file') {
    // Match the timeline's px/s. Fall back to 100 px/s (the default) if
    // we haven't observed a live value yet.
    return Math.max(0.001, (ui.zoomPxPerSecond || 100) / 1000)
  }
  // saved-clip: fit the cropped range exactly into the canvas.
  const w = canvasCssWidth.value
  const dur = viewDurationMs.value
  return w > 0 && dur > 0 ? w / dur : 0
})

const visibleDurationMs = computed(() => {
  const w = canvasCssWidth.value
  const px = basePxPerMs.value
  const fullDur = viewDurationMs.value
  if (w <= 0 || px <= 0 || fullDur <= 0) return fullDur
  const dur = w / (px * zoom.value)
  return Math.min(fullDur, dur)
})
const maxScrollMs = computed(() => Math.max(0, viewDurationMs.value - visibleDurationMs.value))
const visibleInMs = computed(() => viewInMs.value + Math.min(maxScrollMs.value, Math.max(0, scrollMs.value)))
const visibleEndMs = computed(() => visibleInMs.value + visibleDurationMs.value)
const zoomPercent = computed(() => Math.round(zoom.value * 100))

function resetZoom(): void {
  zoom.value = 1
  scrollMs.value = 0
}

function setZoomAnchored(nextZoom: number, anchorMs: number): void {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom))
  if (z === zoom.value) return
  const w = canvasCssWidth.value
  const px = basePxPerMs.value
  const fullDur = viewDurationMs.value
  if (w <= 0 || px <= 0 || fullDur <= 0) {
    zoom.value = z
    return
  }
  const prevVisibleDur = Math.min(fullDur, w / (px * zoom.value))
  const anchorFrac = prevVisibleDur > 0
    ? (anchorMs - visibleInMs.value) / prevVisibleDur
    : 0.5
  zoom.value = z
  const newVisibleDur = Math.min(fullDur, w / (px * z))
  const newLeftMs = (anchorMs - viewInMs.value) - anchorFrac * newVisibleDur
  const maxScroll = Math.max(0, fullDur - newVisibleDur)
  scrollMs.value = Math.max(0, Math.min(maxScroll, newLeftMs))
}

function zoomIn(): void {
  const center = visibleInMs.value + visibleDurationMs.value / 2
  setZoomAnchored(zoom.value * 1.5, center)
}
function zoomOut(): void {
  const center = visibleInMs.value + visibleDurationMs.value / 2
  setZoomAnchored(zoom.value / 1.5, center)
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

  const item = props.item
  if (!item) return
  const isSavedClip = item.kind === 'saved-clip'
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

// Selection window in ms relative to the source. Always lives within [viewInMs, viewEndMs].
const selectionInMs = ref(0)
const selectionDurationMs = ref(0)
const selectionEndMs = computed(() => selectionInMs.value + selectionDurationMs.value)

// Has the user changed anything from the persisted saved-clip window?
// True when EITHER the selection is narrower than the cropped view,
// OR the cropped view itself differs from `derivedFrom` (because the
// user clicked Crop one or more times). Apply trim is enabled in
// either case — the act of Apply uses the current selection.
const hasSelectionChanged = computed(() => {
  const item = props.item
  if (!item || item.kind !== 'saved-clip') return false
  const origIn = item.derivedFrom?.inMs ?? 0
  const origDur = item.derivedFrom?.durationMs ?? item.durationMs
  if (selectionInMs.value !== origIn || selectionDurationMs.value !== origDur) return true
  if (cropViewInMs.value !== origIn || cropViewDurationMs.value !== origDur) return true
  return false
})

const canApplyTrim = computed(() => {
  const item = props.item
  return !!item && item.kind === 'saved-clip' && hasSelectionChanged.value
})

// Non-destructive crop: snap the cropped working view to the current
// selection so the user can audition / fine-tune the new range
// before committing it to the library. Enabled whenever there's a
// narrowing selection (selection strictly inside the cropped view).
const canApplyCrop = computed(() => {
  if (!props.item) return false
  if (selectionDurationMs.value <= 0) return false
  return (
    selectionInMs.value > cropViewInMs.value + 0.5 ||
    selectionEndMs.value < cropViewInMs.value + cropViewDurationMs.value - 0.5
  )
})

const canSaveAsNew = computed(() => {
  return !!sourceItem.value && selectionDurationMs.value > 0
})

const playheadAbsMs = computed(() => viewInMs.value + preview.positionMs)

// True when the user has narrowed the view with a real selection.
// Playback honours this range: play loops within [selectionInMs, selectionEndMs].
const hasPlaybackSelection = computed(() => {
  if (selectionDurationMs.value <= 0) return false
  return (
    selectionInMs.value > viewInMs.value + 0.5 ||
    selectionEndMs.value < viewEndMs.value - 0.5
  )
})

const playbackStartMs = computed(() =>
  hasPlaybackSelection.value ? selectionInMs.value : viewInMs.value
)
const playbackEndMs = computed(() =>
  hasPlaybackSelection.value ? selectionEndMs.value : viewEndMs.value
)

const loopEnabled = ref(false)

watch(
  () => props.open,
  async (open) => {
    ui.clipEditorOpen = open
    if (open) {
      viewExpanded.value = false
      resetZoom()
      initSelectionForItem()
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
      preview.unload()
      library.setEditorHiResPeaks(null)
      lastHiResRequestKey = ''
      cropUndoStack.value = []
      cropRedoStack.value = []
    }
  }
)

watch(
  () => props.item?.id,
  () => {
    if (!props.open) return
    viewExpanded.value = false
    resetZoom()
    initSelectionForItem()
    lastHiResRequestKey = ''
    cropUndoStack.value = []
    cropRedoStack.value = []
    library.setEditorHiResPeaks(null)
    drawWaveform()
    loadPreviewForView()
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
  if (!expanded) {
    // Snap the cropped view to the user's current selection so it
    // becomes the new focused range. Fall back to keeping the
    // existing crop when the selection has been cleared.
    if (selectionDurationMs.value > 0) {
      cropViewInMs.value = Math.max(0, selectionInMs.value)
      cropViewDurationMs.value = Math.max(0, selectionDurationMs.value)
    }
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
    const item = props.item
    if (!item) return
    const isSavedClip = item.kind === 'saved-clip'
    const looping = loopEnabled.value && (hasPlaybackSelection.value || isSavedClip)
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

function onWindowKeydownCapture(e: KeyboardEvent): void {
  if (!props.open) return
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
  preview.unload()
  window.removeEventListener('keydown', onWindowKeydownCapture, { capture: true })
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})

function initSelectionForItem(): void {
  const item = props.item
  if (!item) {
    selectionInMs.value = 0
    selectionDurationMs.value = 0
    cropViewInMs.value = 0
    cropViewDurationMs.value = 0
    return
  }
  if (item.kind === 'saved-clip') {
    const persistedIn = item.derivedFrom?.inMs ?? 0
    const persistedDur = item.derivedFrom?.durationMs ?? item.durationMs
    cropViewInMs.value = persistedIn
    cropViewDurationMs.value = persistedDur
    selectionInMs.value = persistedIn
    selectionDurationMs.value = persistedDur
  } else {
    // The main source is immutable — open with no selection. The user
    // drags on the waveform to mark a range, then "Save as new clip".
    cropViewInMs.value = 0
    cropViewDurationMs.value = sourceDurationMs.value
    selectionInMs.value = 0
    selectionDurationMs.value = 0
  }
}

// The preview is always loaded for the full clip view (the source range for
// audio-files; the cropped range for saved-clips). The selection is now a
// passive marker indicating what would be saved/applied; the playhead is a
// free cursor anywhere inside the view.
function loadPreviewForView(): void {
  const item = props.item
  if (!item) return
  const src = sourceItem.value
  if (!src) return
  // Pass any warp defaults stored on the library item (saved-clips
  // carry the user's preferred warp at the time the clip was saved)
  // so the preview voice plays the clip the way the timeline will.
  // Audio-file items don't carry warp metadata, so the spread is a
  // no-op for them.
  const sourceBpm = libraryItemSourceBpm(item, library.items)
  const tempoRatio = isWarpActive({
    warpEnabled: item.warpEnabled,
    tempoRatio: item.tempoRatio,
    sourceBpm,
    projectBpm: transport.bpm
  })
    ? effectiveTempoRatio({
        tempoRatio: item.tempoRatio,
        sourceBpm,
        projectBpm: transport.bpm
      })
    : item.tempoRatio
  preview.load(src.id, viewInMs.value, viewDurationMs.value, {
    warpEnabled: item.warpEnabled,
    warpMode: item.warpMode,
    tempoRatio,
    semitones: item.semitones,
    cents: item.cents
  })
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
  // Prefer the editor's high-resolution peaks (computed on demand when
  // the user zooms in past EDITOR_HI_RES_ZOOM_THRESHOLD) over the
  // shared default-resolution peaks on the library item. Both are
  // alternating min/max float pairs covering the whole source.
  const hiRes = library.editorHiResPeaks
  const peaks =
    hiRes && hiRes.libraryItemId === src.id && hiRes.peaks.length >= 2
      ? hiRes.peaks
      : src.peaks
  if (peaks && peaks.length >= 2 && sourceTotal > 0) {
    const pairs = Math.floor(peaks.length / 2)
    const peakStart = (vIn / sourceTotal) * pairs
    const peakSpan = (vDur / sourceTotal) * pairs
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
  // audio-file always shows handles; saved-clip shows handles only after
  // the user has narrowed the selection inside the cropped view.
  const fullVIn = viewInMs.value
  const fullVEnd = viewEndMs.value
  const isSubSelection =
    selectionInMs.value > fullVIn + 0.5 || selectionEndMs.value < fullVEnd - 0.5
  const showHandles = props.item?.kind === 'audio-file' || isSubSelection
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
  const item = props.item
  const isSavedClip = item?.kind === 'saved-clip'
  const hasSel = hasPlaybackSelection.value
  // Bound playback by the selection if narrowed, or by the full clip
  // when looping a saved clip with no selection.
  const bounded = hasSel || (isSavedClip && loopEnabled.value)
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
  if (e.key === 'Escape') {
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

function onBackdropMouseDown(e: MouseEvent): void {
  // Track whether the user pressed mouse-down on the backdrop itself.
  // Without this, a drag that *started* on the waveform but ends with
  // the cursor over the backdrop synthesises a `click` whose target
  // is the backdrop — `@click.self` would then fire and close the
  // dialog mid-edit. We only treat a click as a backdrop click when
  // the originating mouse-down landed on the backdrop.
  backdropMouseDownTarget.value = e.target === e.currentTarget
}

function onBackdropClick(e: MouseEvent): void {
  if (!backdropMouseDownTarget.value) return
  if (e.target !== e.currentTarget) return
  emit('close')
}

const backdropMouseDownTarget = ref(false)

// Dialog-local undo stack for Crop operations. Crop is purely
// non-destructive (it just narrows the working view); committing the
// final result via Apply trim goes through the project-wide
// UndoManager and gets its own undo step there. We keep this stack
// scoped to the dialog so closing it discards any uncommitted crops
// — the library entry hasn't been touched.
interface CropSnapshot {
  cropViewInMs: number
  cropViewDurationMs: number
  selectionInMs: number
  selectionDurationMs: number
}
const cropUndoStack = ref<CropSnapshot[]>([])
const cropRedoStack = ref<CropSnapshot[]>([])

function captureCropSnapshot(): CropSnapshot {
  return {
    cropViewInMs: cropViewInMs.value,
    cropViewDurationMs: cropViewDurationMs.value,
    selectionInMs: selectionInMs.value,
    selectionDurationMs: selectionDurationMs.value
  }
}

function restoreCropSnapshot(snap: CropSnapshot): void {
  cropViewInMs.value = snap.cropViewInMs
  cropViewDurationMs.value = snap.cropViewDurationMs
  selectionInMs.value = snap.selectionInMs
  selectionDurationMs.value = snap.selectionDurationMs
  resetZoom()
  scrollMs.value = 0
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
  scrollMs.value = 0
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

function onApplyTrim(): void {
  const item = props.item
  if (!item) return
  // Apply trim commits whatever the user is currently looking at.
  // After Crop operations the cropped view IS the working state; if
  // there's a still-narrower selection inside it, use that as the
  // commit target instead (matches the user's mental "save the
  // selection" model). Falls back to the cropped view bounds when
  // there's no narrowing selection.
  const targetIn =
    canApplyCrop.value || selectionDurationMs.value > 0
      ? selectionInMs.value
      : cropViewInMs.value
  const targetDur =
    canApplyCrop.value || selectionDurationMs.value > 0
      ? selectionDurationMs.value
      : cropViewDurationMs.value
  const result = library.updateSavedClipTrim(item.id, targetIn, targetDur)
  if (result.ok) {
    notifications.pushInfo(`Updated trim for "${libraryItemDisplayName(item)}".`)
    emit('close')
  } else if (result.conflictingTrackNames && result.conflictingTrackNames.length > 0) {
    notifications.pushError(
      `Cannot apply trim — it would overlap clips on ${result.conflictingTrackNames.join(', ')}.`
    )
  } else {
    notifications.pushError('Cannot apply trim — invalid selection.')
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
      v-if="open && item && sourceItem"
      class="fixed inset-0 z-[1100] flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clip-editor-title"
      @mousedown="onBackdropMouseDown"
      @click="onBackdropClick"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="flex h-[min(980px,96vh)] w-[min(1440px,98vw)] flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-200 shadow-2xl outline-none"
        @keydown="onKeydown"
      >
        <header class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-zinc-800 px-5 py-3">
          <div class="min-w-0 justify-self-start">
            <div class="flex min-w-0 items-center gap-2">
              <h2
                id="clip-editor-title"
                class="truncate text-base font-semibold text-zinc-100"
              >
                {{ libraryItemDisplayName(item) }}
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

        <div class="flex flex-1 flex-col gap-3 px-5 py-4">
          <canvas
            ref="waveformEl"
            class="h-[min(364px,36vh)] w-full cursor-crosshair rounded border border-zinc-800 bg-zinc-950"
            @mousedown="onCanvasMouseDown"
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
              <button
                v-if="item.kind === 'saved-clip'"
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

        <footer class="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button
            type="button"
            class="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            @click="emit('close')"
          >
            Close
          </button>
          <!-- Non-destructive crop: narrows the working view to the
               current selection so the user can audition/tweak before
               committing. Local Ctrl+Z / Ctrl+Y undo/redo while the
               dialog is open. Closing without Apply trim discards
               every crop — the library entry is untouched. -->
          <button
            type="button"
            class="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!canApplyCrop"
            title="Crop the working view to the selection (Ctrl+Z to undo)"
            @click="onApplyCrop"
          >
            Crop
          </button>
          <button
            v-if="item.kind === 'saved-clip'"
            type="button"
            class="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!canApplyTrim"
            title="Save changes to the library and apply to every linked timeline clip"
            @click="onApplyTrim"
          >
            Apply trim
          </button>
          <button
            type="button"
            class="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!canSaveAsNew"
            @click="onSaveAsNew"
          >
            Save as new clip
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>
