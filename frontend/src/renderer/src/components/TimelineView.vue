<script setup lang="ts">
// Timeline canvas. Renders track rows with their clips' waveforms.
//
// Implementation is split across composables under `@/lib/timeline/`:
//   - usePixiApp         — PixiJS Application lifecycle + scene-graph layers
//   - useGridGeometry    — zoom (pxPerSecond), header width, BPM-derived units
//   - useTimelineScroll  — scrollX/Y, scrollbar thumb geometry, clampScroll
//   - useTimelineDrawing — every Pixi draw routine (ruler, grid, tracks,
//                          clips, playhead, drop-preview ghost)
//   - useScrollbarDrag   — pointer-driven horizontal + vertical scrollbar drag
//   - useDragHandlers    — pointer-down → clip drag or playhead seek-drag
//   - useDropZone        — library-item drag/drop landing zone + preview ghost
//
// The component itself owns wheel-zoom, the track-header-column resize
// handle, the watches that trigger repaints, and the host element +
// template wiring. Drawing logic lives in `useTimelineDrawing`; scrollbar
// pointer handling lives in `useScrollbarDrag`.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore, TRACK_PALETTE } from '@/stores/projectStore'
import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { clipEffectiveDurationMs, isWarpActive, isWarpPending } from '@/lib/warp'
import TrackHeaderPanel from '@/components/TrackHeaderPanel.vue'
import ClipContextMenu, { type ClipContextMenuItem } from '@/components/ClipContextMenu.vue'
import ClipWarpDialog from '@/components/ClipWarpDialog.vue'
import {
  DEFAULT_PX_PER_SECOND,
  RULER_HEIGHT,
  SCROLLBAR_HEIGHT,
  SCROLLBAR_WIDTH,
  ZOOM_STEP_PX_PER_SECOND
} from '@/lib/timeline/constants'
import { useGridGeometry } from '@/lib/timeline/useGridGeometry'
import { useTimelineScroll } from '@/lib/timeline/useTimelineScroll'
import { tracksContentHeight as tracksContentHeight_, trackTopWorldYAt } from '@/lib/timeline/trackLayout'
import { usePixiApp } from '@/lib/timeline/usePixiApp'
import { useDragHandlers, type ClipHitRegion } from '@/lib/timeline/useDragHandlers'
import { useDropZone } from '@/lib/timeline/useDropZone'
import { useTimelineDrawing } from '@/lib/timeline/useTimelineDrawing'
import { useScrollbarDrag } from '@/lib/timeline/useScrollbarDrag'
import { send as sendBridge } from '@/lib/bridgeService'

const project = useProjectStore()
const library = useLibraryStore()
const transport = useTransportStore()
const ui = useUiStore()
const host = ref<HTMLDivElement | null>(null)

// `redraw` / `updatePlayhead` are populated once `useTimelineDrawing` has
// been instantiated below. Declared as `let`-bindings up front so the
// callbacks we pass to `usePixiApp`, `useDragHandlers` and `useDropZone`
// (which fire long after wiring, on resize / pointer / drop events) can
// dispatch to the real functions without a chicken-and-egg.
let redraw: () => void = () => { }
let updatePlayhead: () => void = () => { }

// ─── Composables ──────────────────────────────────────────────────────────
const geometry = useGridGeometry()
const { pxPerSecond, headerWidth, headerWidthRef, contentPx } = geometry

const tracksContentHeightPx = computed(() => tracksContentHeight_(project.tracks))
const scroll = useTimelineScroll({ contentPx, headerWidthRef, tracksContentHeightPx })
const {
  scrollX, scrollY, viewportWidth, viewportHeight,
  trackAreaWidth, maxScrollX, showScrollbar, thumbWidthPx, thumbLeftPx,
  tracksContentHeight, trackAreaHeight, vLaneHeight, maxScrollY,
  vThumbHeightPx, vThumbTopPx, clampScroll
} = scroll

// Viewport-space rectangles for every drawn clip; populated by
// `useTimelineDrawing` on each redraw and consumed by `useDragHandlers`
// for hit-testing. Shared as a stable array reference; the drag handlers
// read the live contents via a getter so we never copy.
const clipHitRegions: ClipHitRegion[] = []

const pixi = usePixiApp({
  host, viewportWidth, viewportHeight,
  onResize: () => { clampScroll(); redraw(); updatePlayhead() },
  onReady: () => { redraw(); updatePlayhead() }
})

const { isDraggingPlayhead, hoverCursor } = useDragHandlers({
  host, app: pixi.app, scrollX, scrollY, maxScrollX, showScrollbar, geometry,
  getClipHitRegions: () => clipHitRegions,
  onClipMoved: () => { redraw(); updatePlayhead() },
  onMarkerMoved: () => { redraw(); updatePlayhead() },
  onPlayheadMoved: () => { updatePlayhead() }
})

const { dropPreview } = useDropZone({
  host, app: pixi.app, scrollX, scrollY, showScrollbar, geometry,
  onPreviewChanged: () => { updatePlayhead() }
})

const drawing = useTimelineDrawing({
  app: pixi.app,
  rulerLayer: pixi.rulerLayer,
  rulerTicksLayer: pixi.rulerTicksLayer,
  tracksLayer: pixi.tracksLayer,
  headersLayer: pixi.headersLayer,
  playheadLayer: pixi.playheadLayer,
  GraphicsCtor: pixi.GraphicsCtor,
  TextCtor: pixi.TextCtor,
  geometry,
  scrollX, scrollY, showScrollbar, maxScrollX,
  trackAreaHeight, tracksContentHeight,
  clampScroll,
  clipHitRegions, isDraggingPlayhead, dropPreview
})
redraw = drawing.redraw
updatePlayhead = drawing.updatePlayhead
const applyScroll = drawing.applyScroll
const setDisplayPositionMs = drawing.setDisplayPositionMs

const hasPendingWarpClip = computed(() =>
  Object.values(project.clips).some((clip) => {
    const libItem = library.items.find((i) => i.id === clip.libraryItemId)
    return isWarpPending({
      warpEnabled: clip.warpEnabled,
      tempoRatio: clip.tempoRatio,
      pendingAutoWarp: clip.pendingAutoWarp,
      sourceBpm: libItem?.bpm,
      projectBpm: transport.bpm
    })
  })
)

// Template refs for the two scrollbar lanes. Declared here (rather than
// inside `useScrollbarDrag`) so the `ref="scrollbarTrack"` /
// `ref="vScrollbarTrack"` template bindings are visible to the TS
// language server in the component's own scope.
const scrollbarTrack = ref<HTMLDivElement | null>(null)
const vScrollbarTrack = ref<HTMLDivElement | null>(null)

const {
  onThumbPointerDown, onThumbPointerMove, onThumbPointerUp, onTrackPointerDown,
  onVThumbPointerDown, onVThumbPointerMove, onVThumbPointerUp, onVTrackPointerDown
} = useScrollbarDrag({
  scrollX, maxScrollX, trackAreaWidth, thumbWidthPx, showScrollbar, scrollbarTrack,
  scrollY, maxScrollY, vLaneHeight, vThumbHeightPx, vScrollbarTrack,
  // Scrollbar drag is now O(1): just translate the world layers.
  // `applyScroll` internally calls `updatePlayhead` so the head re-pins
  // to the right viewport x.
  onScroll: () => { applyScroll() }
})

// Mouse-wheel zoom is attached directly to the host so we can
// `preventDefault` (passive: false is only available via addEventListener).
// The PixiJS init and all other pointer/drag handlers live in composables.
onMounted(() => {
  host.value?.addEventListener('wheel', onWheel, { passive: false })
  host.value?.addEventListener('contextmenu', onContextMenu)
  host.value?.addEventListener('dblclick', onDoubleClick)
  startPlayheadRaf()
})
onBeforeUnmount(() => {
  host.value?.removeEventListener('wheel', onWheel)
  host.value?.removeEventListener('contextmenu', onContextMenu)
  host.value?.removeEventListener('dblclick', onDoubleClick)
  document.removeEventListener('keydown', onRenameDocumentKeyDown, { capture: true })
  document.removeEventListener('pointerdown', onRenameDocumentPointerDown, { capture: true })
  stopPlayheadRaf()
})

// ─── Clip context menu ────────────────────────────────────────────────────
// Right-click on a clip block opens a floating menu. Hit-testing uses the
// same world-space `clipHitRegions` array `useDragHandlers` reads — we
// convert the pointer to world coords by adding the current scroll.
const contextMenuOpen = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuClipId = ref<string | null>(null)
// Warp settings dialog. Surfaced from the right-click context menu;
// driven entirely by `project.setClipWarp` so closing without an
// explicit "save" doesn't lose anything (every slider change has
// already committed).
const warpDialogOpen = ref(false)
const warpDialogClipId = ref<string | null>(null)
const contextMenuItems = computed<ClipContextMenuItem[]>(() => {
  const clip = contextMenuClipId.value ? project.clips[contextMenuClipId.value] : null
  const items: ClipContextMenuItem[] = []
  if (clip?.unresolved) {
    items.push({ command: 'clip.relink', label: 'Relink…' })
  }
  items.push({ command: 'clip.delete', label: 'Delete' })
  items.push({ command: 'clip.duplicate', label: 'Duplicate', separatorAbove: true })
  items.push({ command: 'clip.split', label: 'Split at playhead' })
  // Colour picker — inline 4×8 swatch grid bound to the 16-entry
  // TRACK_PALETTE. Picking a swatch sends `CLIP_COLOR` via
  // setClipColor; the selected outline reflects either the clip's
  // override or the host track's inherited colour as a hint.
  if (clip) {
    const track = project.tracks.find((t) => t.id === clip.trackId)
    const selected =
      typeof clip.colorIndex === 'number'
        ? clip.colorIndex
        : track
          ? track.colorIndex
          : undefined
    items.push({
      command: 'clip.color',
      label: 'Colour',
      separatorAbove: true,
      swatches: TRACK_PALETTE.map((p) => ({ cssHex: p.cssHex, label: p.id })),
      selectedSwatch: selected
    })
  }
  // Warp settings — opens the per-clip warp dialog. Enabled now that
  // the warp engine is wired through the audio path; Transpose stays
  // disabled until pitch-only without time-stretch ships as a
  // first-class control.
  items.push({ command: 'clip.warp', label: 'Warp settings…', separatorAbove: true })
  items.push({ command: 'clip.transpose', label: 'Transpose…', disabled: true })
  items.push({ command: 'clip.saveToLibrary', label: 'Save clip to library', separatorAbove: true })
  // "Unlink from library" only shown when the clip is linked to a
  // saved-clip library entry. Unlinking preserves the current trim
  // window and rebinds the clip to the saved-clip's underlying
  // audio-file source — the audio plays identically; only the link
  // is gone (so future edits to the saved-clip stop propagating).
  if (clip) {
    const parent = library.items.find((i) => i.id === clip.libraryItemId)
    if (parent?.kind === 'saved-clip') {
      items.push({ command: 'clip.unlink', label: 'Unlink from library' })
    }
  }
  items.push({ command: 'clip.saveSample', label: 'Bounce to Sample…', disabled: true })
  return items
})

function onContextMenu(e: MouseEvent): void {
  if (!host.value) return
  const rect = host.value.getBoundingClientRect()
  const worldX = (e.clientX - rect.left) + scrollX.value
  const worldY = (e.clientY - rect.top) + scrollY.value
  // Reverse iterate so the visually top-most clip wins on overlap.
  for (let i = clipHitRegions.length - 1; i >= 0; i--) {
    const r = clipHitRegions[i]
    if (!r) continue
    if (worldX >= r.x && worldX <= r.x + r.w && worldY >= r.y && worldY <= r.y + r.h) {
      e.preventDefault()
      contextMenuClipId.value = r.clipId
      contextMenuX.value = e.clientX
      contextMenuY.value = e.clientY
      contextMenuOpen.value = true
      return
    }
  }
  // Not on a clip — let the browser default contextmenu happen (which
  // is a no-op in Electron) so we don't accidentally swallow the event
  // for the rest of the layout.
}

function onContextMenuCommand(command: string): void {
  const clipId = contextMenuClipId.value
  if (!clipId) return
  if (command === 'clip.delete') {
    project.removeClip(clipId)
  } else if (command === 'clip.duplicate') {
    project.duplicateClip(clipId)
  } else if (command === 'clip.split') {
    project.splitClipAt(clipId, transport.positionMs)
  } else if (command === 'clip.saveToLibrary') {
    project.saveClipToLibrary(clipId)
  } else if (command === 'clip.unlink') {
    project.unlinkClipFromLibrary(clipId)
  } else if (command === 'clip.warp') {
    warpDialogClipId.value = clipId
    warpDialogOpen.value = true
  } else if (command.startsWith('clip.color:')) {
    const idx = Number.parseInt(command.slice('clip.color:'.length), 10)
    if (Number.isFinite(idx)) project.setClipColor(clipId, idx)
  } else if (command === 'clip.relink') {
    const clip = project.clips[clipId]
    if (clip) {
      const slash = Math.max(clip.filePath.lastIndexOf('\\'), clip.filePath.lastIndexOf('/'))
      const defaultPath = slash > 0 ? clip.filePath.slice(0, slash) : undefined
      void window.silverdaw
        .chooseAudioFile({ title: `Locate ${clip.fileName}`, defaultPath })
        .then((picked) => {
          if (picked) project.relinkLibraryItem(clip.libraryItemId, picked)
        })
    }
  }
  contextMenuClipId.value = null
}

function onContextMenuClose(): void {
  contextMenuOpen.value = false
  contextMenuClipId.value = null
}

function markerAtPointer(e: MouseEvent): string | null {
  if (!host.value) return null
  const a = pixi.app.value
  if (!a) return null
  const rect = host.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
  if (y < 0 || y > RULER_HEIGHT || x < headerWidth() || x > rightEdge) return null
  const worldX = x + scrollX.value
  const hitHalfWidth = 7
  for (let i = project.markers.length - 1; i >= 0; i--) {
    const marker = project.markers[i]
    if (!marker) continue
    const markerX = headerWidth() + (marker.positionMs / 1000) * pxPerSecond.value
    if (Math.abs(worldX - markerX) <= hitHalfWidth) return marker.id
  }
  return null
}

function pointerToSnappedRulerMs(e: MouseEvent): number | null {
  if (!host.value) return null
  const a = pixi.app.value
  if (!a) return null
  const rect = host.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
  if (y < 0 || y > RULER_HEIGHT || x < headerWidth() || x > rightEdge) return null
  const rawMs = ((scrollX.value + x - headerWidth()) / pxPerSecond.value) * 1000
  const snap = geometry.msPerSubBeat()
  return Math.max(0, Math.round(rawMs / snap) * snap)
}

function onDoubleClick(e: MouseEvent): void {
  if (e.button !== 0) return

  // First: did the user double-click a clip's title header?
  // If so, open the inline rename overlay. This takes priority over the
  // marker / ruler handling below so the rename gesture is reachable
  // anywhere the title strip is visible.
  if (host.value) {
    const rect = host.value.getBoundingClientRect()
    const worldX = (e.clientX - rect.left) + scrollX.value
    const worldY = (e.clientY - rect.top) + scrollY.value
    for (let i = clipHitRegions.length - 1; i >= 0; i--) {
      const r = clipHitRegions[i]
      if (!r) continue
      if (
        worldX >= r.x &&
        worldX <= r.x + r.w &&
        worldY >= r.y &&
        worldY <= r.y + CLIP_HEADER_H
      ) {
        e.preventDefault()
        startClipRename(r.clipId)
        return
      }
    }
  }

  const markerId = markerAtPointer(e)
  if (markerId) {
    e.preventDefault()
    project.removeMarker(markerId)
    return
  }

  const snappedMs = pointerToSnappedRulerMs(e)
  if (snappedMs === null) return
  e.preventDefault()
  project.toggleMarkerAt(snappedMs)
}

// ─── Inline clip-name rename ──────────────────────────────────────────────
// Double-click on a clip's title strip opens an HTML <input> floating
// over the strip. Enter (or click-outside) commits via `project.renameClip`;
// Escape cancels. The input position is computed reactively from the
// clip's startMs/durationMs and the current scroll/zoom so it follows
// the clip if the user scrolls during the edit.

/** Must mirror the HEADER_H used inside `useTimelineDrawing.drawClipHeader`. */
const CLIP_HEADER_H = 18
const CLIP_HEADER_PAD_X = 4
const CLIP_HEADER_APPROX_CHAR_W = 6
const CLIP_HEADER_LINK_BADGE_W = 18
const CLIP_HEADER_WARP_PENDING_BADGE_W = 18
const CLIP_HEADER_WARP_ACTIVE_BADGE_W = 42

const renamingClipId = ref<string | null>(null)
const renameValue = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

const renameOverlayStyle = computed<Record<string, string> | null>(() => {
  const id = renamingClipId.value
  if (!id) return null
  const clip = project.clips[id]
  if (!clip) return null
  const trackIndex = project.tracks.findIndex((t) => t.id === clip.trackId)
  if (trackIndex < 0) return null

  // World coords mirror `useTimelineDrawing` so the input lands exactly
  // on top of the drawn header strip.
  const absX = headerWidth() + (clip.startMs / 1000) * pxPerSecond.value
  const rowWorldY = trackTopWorldYAt(project.tracks, trackIndex)
  const padding = 4
  const innerY = rowWorldY + padding
  const libItem = library.items.find((i) => i.id === clip.libraryItemId)
  const effectiveDurMs = clipEffectiveDurationMs(clip, libItem, transport.bpm)
  const clipWidthPx = (effectiveDurMs / 1000) * pxPerSecond.value
  const displayName = clip.name?.trim()
    ? clip.name
    : libItem ? libraryItemDisplayName(libItem) : clip.fileName
  const isLinked = libItem?.kind === 'saved-clip'
  const warpPending = isWarpPending({
    warpEnabled: clip.warpEnabled,
    tempoRatio: clip.tempoRatio,
    pendingAutoWarp: clip.pendingAutoWarp,
    sourceBpm: libItem?.bpm,
    projectBpm: transport.bpm
  })
  const warpActive = !warpPending && isWarpActive({
    warpEnabled: clip.warpEnabled,
    tempoRatio: clip.tempoRatio,
    sourceBpm: libItem?.bpm,
    projectBpm: transport.bpm
  })
  const badgeWidth =
    (isLinked ? CLIP_HEADER_LINK_BADGE_W : 0) +
    (warpPending ? CLIP_HEADER_WARP_PENDING_BADGE_W : warpActive ? CLIP_HEADER_WARP_ACTIVE_BADGE_W : 0)
  const naturalHeaderWidth =
    displayName.length * CLIP_HEADER_APPROX_CHAR_W + CLIP_HEADER_PAD_X * 2 + badgeWidth
  const widthPx = Math.max(120, Math.min(clipWidthPx, naturalHeaderWidth))

  // Convert to viewport pixels (relative to host).
  const left = absX - scrollX.value
  const top = innerY - scrollY.value

  return {
    position: 'absolute',
    left: `${left}px`,
    top: `${top}px`,
    width: `${widthPx}px`,
    height: `${CLIP_HEADER_H}px`
  }
})

function startClipRename(clipId: string): void {
  const clip = project.clips[clipId]
  if (!clip) return
  const libItem = library.items.find((i) => i.filePath === clip.filePath)
  const initial = clip.name?.trim()
    ? clip.name
    : libItem
      ? libraryItemDisplayName(libItem)
      : clip.fileName
  renamingClipId.value = clipId
  renameValue.value = initial
  void nextTick(() => {
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  })
}

function commitClipRename(): void {
  const id = renamingClipId.value
  if (!id) return
  project.renameClip(id, renameValue.value)
  renamingClipId.value = null
}

function cancelClipRename(): void {
  renamingClipId.value = null
}

function onRenameDocumentKeyDown(e: KeyboardEvent): void {
  if (!renamingClipId.value) return
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    commitClipRename()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelClipRename()
  }
}

function onRenameDocumentPointerDown(e: PointerEvent): void {
  if (!renamingClipId.value) return
  const inputEl = renameInputRef.value
  if (!inputEl) return
  if (e.target instanceof Node && inputEl.contains(e.target)) return
  commitClipRename()
}

watch(renamingClipId, (id) => {
  if (id) {
    document.addEventListener('keydown', onRenameDocumentKeyDown, { capture: true })
    document.addEventListener('pointerdown', onRenameDocumentPointerDown, { capture: true })
  } else {
    document.removeEventListener('keydown', onRenameDocumentKeyDown, { capture: true })
    document.removeEventListener('pointerdown', onRenameDocumentPointerDown, { capture: true })
  }
})

/**
 * Apply a global keyboard zoom request from App.vue.
 * Anchors on the current playhead position when on-screen, otherwise
 * on the viewport centre.
 */
function applyKeyboardZoom(action: 'in' | 'out' | 'reset'): void {
  const prev = pxPerSecond.value
  const next = geometry.setPxPerSecond(
    action === 'reset'
      ? DEFAULT_PX_PER_SECOND
      : prev + (action === 'in' ? ZOOM_STEP_PX_PER_SECOND : -ZOOM_STEP_PX_PER_SECOND)
  )
  if (next === prev) return

  // Anchor on the playhead position (in viewport pixels) when visible,
  // otherwise on the viewport centre. Same re-pin math as the wheel
  // handler: solve for scrollX so the anchor world-time stays at the
  // same on-screen pixel after the zoom.
  const a = pixi.app.value
  if (!a) return
  const width = a.renderer.screen.width - SCROLLBAR_WIDTH
  const absPlayheadX = headerWidth() + (transport.positionMs / 1000) * prev
  const viewportPlayheadX = absPlayheadX - scrollX.value
  const anchorX =
    viewportPlayheadX >= headerWidth() && viewportPlayheadX <= width
      ? viewportPlayheadX
      : headerWidth() + (width - headerWidth()) / 2
  const trackLocalX = anchorX - headerWidth()
  const timeAtAnchorSec = (scrollX.value + trackLocalX) / prev
  const newScroll = timeAtAnchorSec * next - trackLocalX
  scrollX.value = Math.max(0, Math.min(maxScrollX.value, newScroll))

  redraw()
  updatePlayhead()
}

watch(
  () => ui.timelineZoomRequest,
  (request, previous) => {
    if (!request || request.id === previous?.id) return
    applyKeyboardZoom(request.action)
  }
)

// ─── Playhead paint loop (RAF) ────────────────────────────────────────────
// We paint the playhead from `requestAnimationFrame` rather than from a
// `watch(transport.positionMs)`:
//   - It batches per-frame work to the display's vsync, avoiding wasted
//     paints when several backend updates land in the same frame.
//   - The cached playhead Graphics + O(1) `applyScroll` make the per-
//     frame cost trivial, so running it every RAF tick is cheap.
//
// We do NOT extrapolate the position locally between backend updates.
// Earlier attempts to do so introduced "playhead lies about where audio
// is" bugs (jumping forward by the pause duration on Play after a seek,
// or snapping backward when the first backend update arrived). The
// playhead now strictly mirrors `transport.positionMs`, which itself
// reflects the audio engine's authoritative position. A 60 Hz backend
// cadence is well above the visual smoothness threshold for a DAW
// timeline, so the trade-off is favourable.
let rafId: number | null = null
let lastWarpSpinnerRedrawMs = 0

function startPlayheadRaf(): void {
  const tick = (): void => {
    rafId = requestAnimationFrame(tick)
    setDisplayPositionMs(transport.positionMs)
    if (hasPendingWarpClip.value) {
      const now = performance.now()
      if (now - lastWarpSpinnerRedrawMs >= 125) {
        lastWarpSpinnerRedrawMs = now
        redraw()
      }
    }
    updatePlayhead()
  }
  rafId = requestAnimationFrame(tick)
}

function stopPlayheadRaf(): void {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
}

// ─── Watches that trigger repaints ────────────────────────────────────────

// Track / clip count changed → full repaint (new row stack or waveform).
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

// Per-track height changes (drag-resize handle in TrackHeaderPanel)
// shift every row below the resized track and grow / shrink the
// tracksContentHeight used by the vertical scrollbar. Both the canvas
// and the scrollbar geometry need to repaint; tracksContentHeightPx is
// already reactive so a `redraw` here is enough.
watch(
  () => project.tracks.map((t) => t.heightPx ?? 0).join(','),
  () => {
    clampScroll()
    redraw()
    updatePlayhead()
  }
)

// Waveform peaks arrived asynchronously for one or more clips (e.g.
// post-reload `WAVEFORM_REQUEST` round-trip). Counter ticks on every
// `setClipPeaks`; cheaper than a deep watch on `project.clips`.
watch(
  () => project.peaksRevision,
  () => redraw()
)

watch(
  () => project.markers.map((marker) => `${marker.id}:${marker.positionMs}`).join('|'),
  () => redraw()
)

// Project length changed → re-clamp scroll. Translation only; no redraw
// needed because clip content didn't change.
watch([maxScrollX, maxScrollY], () => {
  if (pendingSavedScrollX !== null) {
    applySavedScrollX(pendingSavedScrollX)
    if (pendingSavedScrollX !== null) return
  }
  if (clampScroll()) applyScroll()
})

// BPM is editable from the transport bar; the ruler ticks, grid lines and
// snap unit all derive from it, so any change requires a full repaint.
watch(() => transport.bpm, () => {
  redraw()
  updatePlayhead()
})

// The track-header column is user-resizable via the divider drag handle.
// Every cached pixel position (ruler ticks, header backgrounds, clip
// x-coordinates) is computed off `headerWidth()`, so we just repaint on
// each width change.
watch(headerWidthRef, () => {
  redraw()
  updatePlayhead()
})

// ─── Zoom + scroll persistence ─────────────────────────────────────────────
// `project.viewPxPerSecond` and `project.viewScrollX` are the backend-
// authoritative view state. We watch both directions:
//
//   1. backend → renderer:  on PROJECT_STATE the projectStore updates
//      `viewPxPerSecond` / `viewScrollX`. Apply them locally so a
//      freshly-loaded project opens at the zoom AND scroll position
//      that were saved with it. Guards prevent the change bouncing
//      back to the backend.
//   2. renderer → backend:  any wheel zoom OR scroll change that
//      survives a short debounce gets pushed via `PROJECT_SET_VIEW`.
//      The backend stores both fields on the project root without
//      flipping the dirty flag — view state isn't a meaningful edit.
let suppressZoomEmit = false
let suppressScrollEmit = false
let zoomEmitTimer: ReturnType<typeof setTimeout> | null = null
let scrollEmitTimer: ReturnType<typeof setTimeout> | null = null
let pendingSavedScrollX: number | null = null

function applySavedScrollX(saved: number): void {
  if (saved > 0 && maxScrollX.value <= 0) {
    pendingSavedScrollX = saved
    return
  }
  pendingSavedScrollX = null
  const clamped = Math.max(0, Math.min(maxScrollX.value, saved))
  if (Math.abs(clamped - scrollX.value) < 0.5) return
  suppressScrollEmit = true
  scrollX.value = clamped
  applyScroll()
  requestAnimationFrame(() => {
    suppressScrollEmit = false
  })
}

watch(
  () => project.viewPxPerSecond,
  (saved) => {
    if (saved === null) return
    if (Math.abs(saved - pxPerSecond.value) < 0.01) return
    suppressZoomEmit = true
    geometry.setPxPerSecond(saved)
    redraw()
    updatePlayhead()
    requestAnimationFrame(() => {
      suppressZoomEmit = false
    })
  }
)

watch(
  () => project.viewScrollX,
  (saved) => {
    if (saved === null) return
    applySavedScrollX(saved)
  }
)

watch(
  () => ui.timelineScrollRequest,
  (request) => {
    if (!request) return
    let next: number
    if ('edge' in request) {
      next = request.edge === 'start' ? 0 : maxScrollX.value
    } else {
      const targetX = (request.positionMs / 1000) * pxPerSecond.value
      const margin = 24
      const visibleLeft = scrollX.value + margin
      const visibleRight = scrollX.value + trackAreaWidth.value - margin
      if (targetX >= visibleLeft && targetX <= visibleRight) return
      next = targetX < visibleLeft ? targetX - margin : targetX - trackAreaWidth.value + margin
      next = Math.max(0, Math.min(maxScrollX.value, next))
    }
    if (Math.abs(next - scrollX.value) < 0.5) return
    scrollX.value = next
    applyScroll()
  }
)

watch(
  pxPerSecond,
  (next) => {
    // Mirror to the uiStore so the StatusBar (and any other consumer)
    // can show the current zoom without reaching into the timeline
    // composable.
    ui.setZoomPxPerSecond(next)
    if (suppressZoomEmit) return
    if (zoomEmitTimer) clearTimeout(zoomEmitTimer)
    zoomEmitTimer = setTimeout(() => {
      zoomEmitTimer = null
      if (project.viewPxPerSecond !== null && Math.abs(project.viewPxPerSecond - next) < 0.01) return
      sendBridge('PROJECT_SET_VIEW', { pxPerSecond: next })
    }, 200)
  },
  // `immediate` so the StatusBar gets the initial value at mount; the
  // debounced send still waits 200 ms, and the guard below catches the
  // "no change vs. backend" case so we don't spuriously emit.
  { immediate: true }
)

watch(
  scrollX,
  (next) => {
    if (suppressScrollEmit) return
    project.viewScrollX = next
    if (scrollEmitTimer) clearTimeout(scrollEmitTimer)
    scrollEmitTimer = setTimeout(() => {
      scrollEmitTimer = null
      sendBridge('PROJECT_SET_VIEW', { scrollX: next })
    }, 200)
  },
  { flush: 'sync' }
)

// Project length changes also affect grid extent — make sure the grid
// covers the new duration. (Track / clip count changes already trigger
// a redraw via the watcher below; this catches the "user edited Length
// in the transport bar" case where neither count changes.)
watch(
  () => project.durationMs,
  () => redraw()
)

/**
 * Wheel handler — dispatches between two intents based on which axis
 * dominates:
 *
 *   - Horizontal scroll (|deltaX| > |deltaY|) → pan the timeline.
 *     Trackpads naturally emit deltaX on a two-finger horizontal swipe;
 *     mouse wheels usually don't, so vertical mouse-wheel still zooms.
 *   - Vertical scroll → exponential zoom anchored on the pointer's
 *     current time-position so the bar/clip under the cursor stays
 *     fixed on screen.
 *
 * Holding Shift while scrolling vertically also pans (matches the
 * convention used by every browser and most DAWs).
 */
function onWheel(e: WheelEvent): void {
  if (!host.value) return
  e.preventDefault()
  if (project.tracks.length === 0) return

  // Treat as a horizontal pan when the dominant axis is horizontal OR
  // the user is holding Shift. Both branches consume the event so the
  // OS-level scroll bubbling doesn't move the page.
  const absX = Math.abs(e.deltaX)
  const absY = Math.abs(e.deltaY)
  const wantsPan = absX > absY || (e.shiftKey && absY > 0)
  if (wantsPan) {
    // Use deltaX when it's non-zero (trackpad horizontal swipe); fall
    // back to deltaY when Shift was the trigger on a vertical wheel.
    const panBy = absX > 0 ? e.deltaX : e.deltaY
    if (panBy === 0) return
    const next = Math.max(0, Math.min(maxScrollX.value, scrollX.value + panBy))
    if (next === scrollX.value) return
    scrollX.value = next
    applyScroll()
    return
  }

  const delta = e.deltaY
  if (delta === 0) return

  const prev = pxPerSecond.value
  const next = geometry.setPxPerSecond(
    prev + (delta < 0 ? ZOOM_STEP_PX_PER_SECOND : -ZOOM_STEP_PX_PER_SECOND)
  )
  if (next === prev) return

  // Determine the anchor (in track-area-local pixels) and the time it
  // currently sits at, so we can re-pin the same time under the pointer
  // after applying the new zoom.
  const hostRect = host.value.getBoundingClientRect()
  const pointerXInHost = e.clientX - hostRect.left
  const trackLocalX = Math.max(0, Math.min(trackAreaWidth.value, pointerXInHost - headerWidth()))
  const timeAtAnchorSec = (scrollX.value + trackLocalX) / prev

  // Re-anchor: solve for scrollX so the same time sits at the same
  // pointer-local x. `maxScrollX` is reactive on `pxPerSecond`, so by the
  // time we read it here it reflects the new zoom.
  const newScroll = timeAtAnchorSec * next - trackLocalX
  scrollX.value = Math.max(0, Math.min(maxScrollX.value, newScroll))

  redraw()
  updatePlayhead()
}

// ─── Track-header column resize ────────────────────────────────────────────
// The user can drag the vertical divider on the right edge of the track
// header column to grow / shrink it. Width is persisted via `uiStore`.

let headerResizePointerId: number | null = null
let headerResizeStartX = 0
let headerResizeStartWidth = 0

function onHeaderResizePointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  headerResizePointerId = e.pointerId
  headerResizeStartX = e.clientX
  headerResizeStartWidth = ui.trackHeaderWidth
    ; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function onHeaderResizePointerMove(e: PointerEvent): void {
  if (headerResizePointerId !== e.pointerId) return
  const delta = e.clientX - headerResizeStartX
  ui.setTrackHeaderWidth(headerResizeStartWidth + delta)
}

function onHeaderResizePointerUp(e: PointerEvent): void {
  if (headerResizePointerId !== e.pointerId) return
  headerResizePointerId = null
    ; (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
}
</script>

<template>
  <div class="relative h-full w-full overflow-hidden">
    <div
      ref="host"
      class="absolute inset-0"
      :style="{ cursor: hoverCursor }"
    />

    <!-- HTML overlay for track headers (name + M/S/X buttons). -->
    <TrackHeaderPanel :scroll-y="scrollY" />

    <!-- Inline rename input for a clip's title strip. Floats over the
             drawn header pixels and updates its position reactively as the
             user scrolls or zooms during the edit. -->
    <input
      v-if="renameOverlayStyle"
      ref="renameInputRef"
      v-model="renameValue"
      type="text"
      spellcheck="false"
      data-borderless-button="true"
      class="z-30 rounded-sm border border-cyan-500 bg-zinc-950 px-1 text-[10px] font-medium text-zinc-100 outline-none"
      :style="renameOverlayStyle"
      @pointerdown.stop
      @dblclick.stop
      @click.stop
    >

    <!-- Vertical divider drag handle. Sits on top of the column boundary
             between the track-header panel and the timeline canvas. The
             visible line is 1px (drawn by Pixi); this hit area is 6px wide
             and straddles the seam so it's easy to grab. -->
    <div
      class="absolute inset-y-0 z-20 w-1.5 cursor-col-resize"
      :style="{ left: (headerWidth() - 3) + 'px' }"
      title="Drag to resize track header column"
      @pointerdown="onHeaderResizePointerDown"
      @pointermove="onHeaderResizePointerMove"
      @pointerup="onHeaderResizePointerUp"
      @pointercancel="onHeaderResizePointerUp"
    />

    <!-- Vertical scrollbar lane. Spans the full canvas height (over the
             ruler row at the top and over the corner above the horizontal
             scrollbar at the bottom) so the thumb travels the entire canvas.
             The thumb only becomes interactive when there's overflow
             (`maxScrollY > 0`). -->
    <div
      ref="vScrollbarTrack"
      class="absolute inset-y-0 right-0 bg-zinc-900/80"
      :class="maxScrollY > 0 ? 'cursor-pointer' : ''"
      :style="{
        width: SCROLLBAR_WIDTH + 'px'
      }"
      @pointerdown="onVTrackPointerDown"
    >
      <div
        v-if="maxScrollY > 0"
        class="absolute left-1 w-2 cursor-grab rounded-full bg-zinc-500 hover:bg-zinc-400 active:cursor-grabbing active:bg-zinc-300"
        :style="{ top: vThumbTopPx + 'px', height: vThumbHeightPx + 'px' }"
        @pointerdown="onVThumbPointerDown"
        @pointermove="onVThumbPointerMove"
        @pointerup="onVThumbPointerUp"
        @pointercancel="onVThumbPointerUp"
      />
    </div>

    <!-- Horizontal scrollbar. Sits above the transport bar (which lives
             outside this component) and to the right of the track header
             column. Only rendered when content overflows the viewport. -->
    <div
      v-if="showScrollbar"
      ref="scrollbarTrack"
      class="absolute bottom-0 cursor-pointer bg-zinc-900/80"
      :style="{
        left: headerWidth() + 'px',
        right: SCROLLBAR_WIDTH + 'px',
        height: SCROLLBAR_HEIGHT + 'px'
      }"
      @pointerdown="onTrackPointerDown"
    >
      <div
        class="absolute top-1 h-2 cursor-grab rounded-full bg-zinc-500 hover:bg-zinc-400 active:cursor-grabbing active:bg-zinc-300"
        :style="{ left: thumbLeftPx + 'px', width: thumbWidthPx + 'px' }"
        @pointerdown="onThumbPointerDown"
        @pointermove="onThumbPointerMove"
        @pointerup="onThumbPointerUp"
        @pointercancel="onThumbPointerUp"
      />
    </div>

    <!-- Empty state hint. -->
    <div
      v-if="project.tracks.length === 0"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600"
    >
      Add a track or open a project to start
    </div>

    <!-- Right-click context menu for clip blocks. Teleported to body
         so its z-index / positioning are independent of the timeline's
         transformed children. -->
    <ClipContextMenu
      :open="contextMenuOpen"
      :x="contextMenuX"
      :y="contextMenuY"
      :items="contextMenuItems"
      @close="onContextMenuClose"
      @command="onContextMenuCommand"
    />

    <!-- Per-clip warp settings. Surfaced from the right-click context
         menu; every control commits live through projectStore so close
         is just a dismiss, never a confirm/cancel. -->
    <ClipWarpDialog
      :open="warpDialogOpen"
      :clip-id="warpDialogClipId"
      @close="warpDialogOpen = false"
    />
  </div>
</template>
