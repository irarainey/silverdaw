<script setup lang="ts">
// Timeline canvas. Renders track rows with their clips' waveforms.
//
// Implementation is split across composables under `@/lib/timeline/`:
//   - usePixiApp       — PixiJS Application lifecycle + scene-graph layers
//   - useGridGeometry  — zoom (pxPerSecond), header width, BPM-derived units
//   - useTimelineScroll — scrollX/Y, scrollbar thumb geometry, clampScroll
//   - useDragHandlers  — pointer-down → clip drag or playhead seek-drag
//   - useDropZone      — library-item drag/drop landing zone + preview ghost
//
// The component itself owns the *drawing* (drawRuler / drawTracks /
// drawClip / drawDropPreview / updatePlayhead / redraw) plus the HTML
// scrollbar handlers and the track-header resize divider.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useProjectStore, type Clip, TRACK_PALETTE } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { PEAKS_PER_SECOND } from '@/lib/audio'
import TrackHeaderPanel from '@/components/TrackHeaderPanel.vue'
import {
    GRID_BAR, GRID_BEAT, GRID_SUB,
    PLAYHEAD,
    RULER_BG, RULER_HEIGHT, RULER_LABEL_HINT, RULER_TICK,
    SCROLLBAR_HEIGHT, SCROLLBAR_WIDTH,
    SUBDIVISIONS_PER_BEAT, TIME_SIG_NUM,
    TRACK_BG, TRACK_GAP, TRACK_HEADER_BG, TRACK_HEIGHT
} from '@/lib/timeline/constants'
import { useGridGeometry } from '@/lib/timeline/useGridGeometry'
import { useTimelineScroll } from '@/lib/timeline/useTimelineScroll'
import { usePixiApp } from '@/lib/timeline/usePixiApp'
import { useDragHandlers, type ClipHitRegion } from '@/lib/timeline/useDragHandlers'
import { useDropZone } from '@/lib/timeline/useDropZone'

const project = useProjectStore()
const transport = useTransportStore()
const ui = useUiStore()
const host = ref<HTMLDivElement | null>(null)

// ─── Composables ──────────────────────────────────────────────────────────
const geometry = useGridGeometry()
const { pxPerSecond, headerWidth, headerWidthRef, contentPx } = geometry

const trackCount = computed(() => project.tracks.length)
const scroll = useTimelineScroll({ contentPx, headerWidthRef, trackCount })
const {
    scrollX, scrollY, viewportWidth, viewportHeight,
    trackAreaWidth, maxScrollX, showScrollbar, thumbWidthPx, thumbLeftPx,
    tracksContentHeight, trackAreaHeight, vLaneHeight, maxScrollY,
    vThumbHeightPx, vThumbTopPx, clampScroll
} = scroll

// Viewport-space rectangles for every drawn clip, populated by `drawClip`
// each redraw and consumed by `useDragHandlers` for hit-testing. Shared via
// a stable array reference (the composable holds a getter).
const clipHitRegions: ClipHitRegion[] = []

const { app, rulerLayer, tracksLayer, headersLayer, playheadLayer,
    GraphicsCtor, TextCtor } = usePixiApp({
    host, viewportWidth, viewportHeight,
    onResize: () => { clampScroll(); redraw(); updatePlayhead() },
    onReady: () => { redraw(); updatePlayhead() }
})

const { isDraggingPlayhead } = useDragHandlers({
    host, app, scrollX, scrollY, showScrollbar, geometry,
    getClipHitRegions: () => clipHitRegions,
    onClipMoved: () => { redraw(); updatePlayhead() },
    onPlayheadMoved: () => { updatePlayhead() }
})

const { dropPreview } = useDropZone({
    host, app, scrollX, scrollY, showScrollbar, geometry,
    onPreviewChanged: () => { updatePlayhead() }
})

// Mouse-wheel zoom is attached directly to the host so we can
// `preventDefault` (passive: false is only available via addEventListener).
// The PixiJS init and all other pointer/drag handlers live in composables.
onMounted(() => {
    host.value?.addEventListener('wheel', onWheel, { passive: false })
})
onBeforeUnmount(() => {
    host.value?.removeEventListener('wheel', onWheel)
})

// ─── Watches that trigger repaints ────────────────────────────────────────

// Track / clip count changed → repaint (new row stack or new waveform).
watch(
    () => [project.tracks.length, Object.keys(project.clips).length] as const,
    () => {
        redraw()
        updatePlayhead()
    }
)

// Playhead moves at 60 Hz from the backend. Also reset scroll on rewind
// to 0 (Stop / Back-to-Start), regardless of whether play was active.
watch(
    () => [transport.isPlaying, transport.positionMs] as const,
    ([, pos], prev) => {
        const prevPos = prev?.[1] ?? 0
        if (pos === 0 && prevPos !== 0 && scrollX.value !== 0) {
            scrollX.value = 0
            redraw()
        }
        updatePlayhead()
    }
)

// Project length changed → re-clamp scroll and repaint.
watch([maxScrollX, maxScrollY], () => {
    if (clampScroll()) redraw()
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

function redraw(): void {
    const a = app.value
    const ruler = rulerLayer.value
    const tracks = tracksLayer.value
    const headers = headersLayer.value
    if (!a || !ruler || !tracks || !headers) return

    ruler.removeChildren()
    tracks.removeChildren()
    headers.removeChildren()
    clipHitRegions.length = 0

    // `screen.width` is the renderer's logical (CSS-pixel) drawing-space
    // width — i.e. the width we should draw to in stage coordinates so that
    // content reaches the right edge of the canvas regardless of
    // devicePixelRatio.
    const width = a.renderer.screen.width

    drawRuler(width)
    drawTracks(width)
    drawHeaderDivider()
}

/**
 * Vertical divider line down the right edge of the track-header column.
 * Drawn on the headers layer so the playhead layer renders ABOVE it — this
 * ensures the playhead and its triangle sit on top of the divider when the
 * transport is at t=0. We draw it as a single full-height line rather than
 * the per-row stub drawn inside `drawTracks` so the divider is continuous
 * over the ruler row and the empty area below the last track.
 */
function drawHeaderDivider(): void {
    const a = app.value
    const headers = headersLayer.value
    const G = GraphicsCtor.value
    if (!a || !headers || !G) return
    const bottom = a.renderer.screen.height
    const divider = new G()
    divider
        .moveTo(headerWidth() - 0.5, 0)
        .lineTo(headerWidth() - 0.5, bottom)
        .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
    headers.addChild(divider)
}

function drawRuler(width: number): void {
    const ruler = rulerLayer.value
    const G = GraphicsCtor.value
    const T = TextCtor.value
    if (!ruler || !G) return

    // Ruler stops short of the vertical scrollbar lane on the right.
    const rightEdge = width - SCROLLBAR_WIDTH

    const bg = new G()
    bg.rect(0, 0, rightEdge, RULER_HEIGHT).fill(RULER_BG)
    bg.moveTo(0, RULER_HEIGHT - 0.5).lineTo(rightEdge, RULER_HEIGHT - 0.5).stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
    ruler.addChild(bg)

    // Iterate quarter-beat (sub) indices in content-space, drawing into one
    // of three Graphics buckets by tier so each tier can have its own stroke
    // style applied in a single call.
    const pxPerBeat = (60 / transport.bpm) * pxPerSecond.value
    const pxPerSub = pxPerBeat / SUBDIVISIONS_PER_BEAT
    const subsPerBar = SUBDIVISIONS_PER_BEAT * TIME_SIG_NUM

    const firstSub = Math.max(0, Math.floor(scrollX.value / pxPerSub))
    const lastSub = Math.ceil((scrollX.value + (rightEdge - headerWidth())) / pxPerSub)

    const subTicks = new G()
    const beatTicks = new G()
    const barTicks = new G()

    for (let s = firstSub; s <= lastSub; s++) {
        const x = headerWidth() + s * pxPerSub - scrollX.value + 0.5
        if (x < headerWidth() || x > rightEdge) continue
        const isBar = s % subsPerBar === 0
        const isBeat = s % SUBDIVISIONS_PER_BEAT === 0
        const tickH = isBar ? 14 : isBeat ? 10 : 5
        const target = isBar ? barTicks : isBeat ? beatTicks : subTicks
        target.moveTo(x, RULER_HEIGHT - tickH).lineTo(x, RULER_HEIGHT - 1)
    }
    subTicks.stroke({ color: GRID_SUB, width: 1, alpha: 0.9 })
    beatTicks.stroke({ color: GRID_BEAT, width: 1, alpha: 0.95 })
    barTicks.stroke({ color: GRID_BAR, width: 1, alpha: 1.0 })
    ruler.addChild(subTicks)
    ruler.addChild(beatTicks)
    ruler.addChild(barTicks)

    // Bar-number labels centred above each bar line. Bars are 0-indexed,
    // so the first bar line (t=0) is labelled "0" and each subsequent
    // bar line increments by one — matching the Bar.Beat.Sub display in
    // the transport bar.
    if (T) {
        const startSub = Math.ceil(firstSub / subsPerBar) * subsPerBar
        for (let s = startSub; s <= lastSub; s += subsPerBar) {
            const x = headerWidth() + s * pxPerSub - scrollX.value + 0.5
            if (x < headerWidth() || x > rightEdge) continue
            const barNumber = s / subsPerBar
            const label = new T({
                text: String(barNumber),
                style: {
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    fontSize: 10,
                    fill: RULER_LABEL_HINT
                }
            })
            // Centre the digits horizontally on the bar line.
            label.x = Math.round(x - label.width / 2)
            label.y = 0
            ruler.addChild(label)
        }
    }

    // Header column background sits in the ruler row too.
    const headerCorner = new G()
    headerCorner.rect(0, 0, headerWidth(), RULER_HEIGHT).fill(TRACK_HEADER_BG)
    ruler.addChild(headerCorner)
}

/**
 * Full-height vertical grid lines spanning the track area. Same musical
 * subdivisions as `drawRuler` (bar / beat / sub-beat) so the ruler ticks and
 * the grid stay visually aligned, allowing items to be placed at quarter-beat
 * resolution later. Drawn on `tracksLayer` between the row backgrounds and
 * the clip blocks so clips obscure the grid where they sit on top of it.
 */
function drawGrid(width: number): void {
    const tracks = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracks || !G) return

    // Don't draw a grid on an empty timeline — it just adds visual noise to
    // the empty-state. The grid reappears the moment the first track is added.
    if (project.tracks.length === 0) return

    const rightEdge = width - SCROLLBAR_WIDTH
    const gridLeft = headerWidth()
    const gridTop = RULER_HEIGHT
    const gridBottom = RULER_HEIGHT + trackAreaHeight.value
    if (gridBottom <= gridTop || rightEdge <= gridLeft) return

    const pxPerBeat = (60 / transport.bpm) * pxPerSecond.value
    const pxPerSub = pxPerBeat / SUBDIVISIONS_PER_BEAT
    const subsPerBar = SUBDIVISIONS_PER_BEAT * TIME_SIG_NUM

    const firstSub = Math.max(0, Math.floor(scrollX.value / pxPerSub))
    const lastSub = Math.ceil((scrollX.value + (rightEdge - gridLeft)) / pxPerSub)

    const subLines = new G()
    const beatLines = new G()
    const barLines = new G()

    for (let s = firstSub; s <= lastSub; s++) {
        const x = gridLeft + s * pxPerSub - scrollX.value + 0.5
        if (x < gridLeft || x > rightEdge) continue
        const isBar = s % subsPerBar === 0
        const isBeat = s % SUBDIVISIONS_PER_BEAT === 0
        const target = isBar ? barLines : isBeat ? beatLines : subLines
        target.moveTo(x, gridTop).lineTo(x, gridBottom)
    }
    subLines.stroke({ color: GRID_SUB, width: 1, alpha: 0.5 })
    beatLines.stroke({ color: GRID_BEAT, width: 1, alpha: 0.7 })
    barLines.stroke({ color: GRID_BAR, width: 1, alpha: 0.95 })

    tracks.addChild(subLines)
    tracks.addChild(beatLines)
    tracks.addChild(barLines)
}

function drawTracks(width: number): void {
    const a = app.value
    const tracksL = tracksLayer.value
    const headers = headersLayer.value
    const G = GraphicsCtor.value
    if (!a || !tracksL || !headers || !G) return

    // Track rows live in the area between the ruler and the horizontal
    // scrollbar lane and to the left of the vertical scrollbar lane.
    const rightEdge = width - SCROLLBAR_WIDTH
    const visibleBottom = RULER_HEIGHT + trackAreaHeight.value

    // Full-height track-header column fill: ensures the left strip reads as
    // a continuous `zinc-900` panel (matching the TransportBar) even when
    // there are no tracks or the track list doesn't fill the viewport. The
    // per-row header rectangles drawn below sit on top of this, so the
    // colour is identical either way.
    const headerColumnBg = new G()
    headerColumnBg
        .rect(0, RULER_HEIGHT, headerWidth(), a.renderer.screen.height - RULER_HEIGHT)
        .fill(TRACK_HEADER_BG)
    tracksL.addChild(headerColumnBg)

    // Pass 1: row backgrounds + headers. Collect visible rows so we can do a
    // second pass for clips AFTER the grid is drawn, ensuring clip blocks
    // visually sit on top of the grid lines.
    const tracks = project.tracks
    const visibleRows: { track: (typeof tracks)[number]; y: number }[] = []
    for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]
        if (!track) continue
        const y = RULER_HEIGHT + i * (TRACK_HEIGHT + TRACK_GAP) - scrollY.value

        // Cull rows that are entirely outside the visible track area.
        if (y + TRACK_HEIGHT <= RULER_HEIGHT) continue
        if (y >= visibleBottom) break

        // Row background (clipped to the track area on the right so it doesn't
        // bleed under the vertical scrollbar lane).
        const rowBg = new G()
        rowBg.rect(0, y, rightEdge, TRACK_HEIGHT).fill(TRACK_BG)
        tracksL.addChild(rowBg)

        // Track header.
        const header = new G()
        header.rect(0, y, headerWidth(), TRACK_HEIGHT).fill(TRACK_HEADER_BG)
        header
            .moveTo(headerWidth() - 0.5, y)
            .lineTo(headerWidth() - 0.5, y + TRACK_HEIGHT)
            .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
        headers.addChild(header)

        visibleRows.push({ track, y })
    }

    // Grid lines: drawn after row backgrounds and across the full visible
    // track area (even past the last row) so the time grid always fills the
    // canvas vertically. Must come BEFORE clip drawing below so clips overlay
    // the grid.
    drawGrid(width)

    // Pass 2: clips.
    for (const { track, y } of visibleRows) {
        // Modular index is always in-bounds; the non-null assertion is for
        // noUncheckedIndexedAccess.
        const palette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
        for (const clipId of track.clipIds) {
            const clip = project.clips[clipId]
            if (!clip) continue
            drawClip(clip, y, palette)
        }
    }
}

function drawClip(clip: Clip, rowY: number, palette: (typeof TRACK_PALETTE)[number]): void {
    const a = app.value
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!a || !tracksL || !G) return

    const viewportWidthPx = a.renderer.screen.width - SCROLLBAR_WIDTH
    const absX = headerWidth() + (clip.startMs / 1000) * pxPerSecond.value
    const w = (clip.durationMs / 1000) * pxPerSecond.value
    const x = absX - scrollX.value

    // Cull entirely off-screen clips so we don't waste CPU on their waveform.
    if (x + w < headerWidth() || x > viewportWidthPx) return

    const padding = 4
    const innerY = rowY + padding
    const innerH = TRACK_HEIGHT - padding * 2
    const midY = innerY + innerH / 2

    // Clip block + border (palette-coloured).
    const block = new G()
    block.roundRect(x, innerY, w, innerH, 4).fill({ color: palette.fill, alpha: 0.85 }).stroke({ color: palette.border, width: 1, alpha: 0.9 })
    tracksL.addChild(block)

    // Record the viewport-space rectangle so pointer-down can hit-test for
    // drag-to-move. The visible region (after culling) is enough.
    clipHitRegions.push({ clipId: clip.id, x, y: innerY, w, h: innerH })

    // Waveform. Only iterate the visible pixel range so very long clips don't
    // tank the framerate when zooming or scrolling.
    const wave = new G()
    const peaks = clip.peaks
    const peakCount = peaks.length / 2
    const samplesPerPixel = Math.max(1, peakCount / w)
    const half = innerH / 2 - 2

    const pxStart = Math.max(0, Math.floor(headerWidth() - x))
    const pxEnd = Math.min(w, Math.ceil(viewportWidthPx - x))

    for (let px = pxStart; px < pxEnd; px++) {
        const startIdx = Math.floor(px * samplesPerPixel)
        const endIdx = Math.min(peakCount, Math.floor((px + 1) * samplesPerPixel))
        if (startIdx >= peakCount) break

        let min = 0
        let max = 0
        for (let i = startIdx; i < endIdx; i++) {
            // Peaks are written in [min, max] pairs by computePeaks(); the
            // bounds check above guarantees both indices are in range.
            const lo = peaks[i * 2]!
            const hi = peaks[i * 2 + 1]!
            if (lo < min) min = lo
            if (hi > max) max = hi
        }

        // Skip silent columns (single-pixel-wide minimum to keep continuity).
        const yTop = midY + max * -half
        const yBot = midY + min * -half
        wave.moveTo(x + px + 0.5, yTop).lineTo(x + px + 0.5, yBot < yTop + 1 ? yTop + 1 : yBot)
    }
    wave.stroke({ color: palette.wave, width: 1, alpha: 0.95 })
    tracksL.addChild(wave)

    // Filename header strip in the top-left of the clip. Sized to fit the
    // filename but capped by the clip width, and skipped entirely if the
    // clip is too narrow to be useful. Drawn last so it overlays the
    // waveform near the top edge.
    drawClipHeader(clip, x, innerY, w, palette)

    // Silence "unused" lint warning for the imported constant.
    void PEAKS_PER_SECOND
}

/**
 * Draw the clip's filename in a coloured strip pinned to its top-left
 * corner. The strip's width is the lesser of the clip's full width and
 * whatever fits the filename plus padding, so short filenames don't span
 * unnecessarily wide. The label is truncated with an ellipsis if even that
 * doesn't fit. Character-width is approximated rather than measured to keep
 * per-clip cost flat.
 */
function drawClipHeader(
    clip: Clip,
    clipX: number,
    clipInnerY: number,
    clipW: number,
    palette: (typeof TRACK_PALETTE)[number]
): void {
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    const T = TextCtor.value
    if (!tracksL || !G || !T) return

    const HEADER_H = 14
    const PAD_X = 4
    const FONT_SIZE = 10
    const APPROX_CHAR_W = 5.5

    // A clip narrower than this can't usefully show even an ellipsis.
    if (clipW < 20) return

    const maxChars = Math.max(1, Math.floor((clipW - PAD_X * 2) / APPROX_CHAR_W))
    const text =
        clip.fileName.length > maxChars
            ? clip.fileName.slice(0, Math.max(1, maxChars - 1)) + '…'
            : clip.fileName

    // Header background: same colour as the clip border so it blends with
    // the outline. Width caps at the clip's own width.
    const desiredW = Math.min(clipW, text.length * APPROX_CHAR_W + PAD_X * 2)
    const headerBg = new G()
    headerBg.rect(clipX, clipInnerY, desiredW, HEADER_H).fill({ color: palette.border, alpha: 0.95 })
    tracksL.addChild(headerBg)

    const label = new T({
        text,
        style: {
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: FONT_SIZE,
            fill: 0x09090b // zinc-950, high contrast against the bright header
        }
    })
    label.x = Math.round(clipX + PAD_X)
    label.y = Math.round(clipInnerY + (HEADER_H - FONT_SIZE) / 2 - 1)
    tracksL.addChild(label)
}

/**
 * Draw / move the playhead. Cheap to call every frame because we just
 * recreate one Graphics on the dedicated layer rather than rebuilding the
 * whole scene. Position is read from `transport.positionMs` (mirrored from
 * the backend's PLAYHEAD_UPDATE messages at 60 Hz).
 *
 * Also runs the auto-scroll logic: while playing, once the playhead reaches
 * the horizontal centre of the visible timeline, the content scrolls so the
 * playhead stays pinned at the centre.
 */
function updatePlayhead(): void {
    const a = app.value
    const playhead = playheadLayer.value
    const G = GraphicsCtor.value
    if (!a || !playhead || !G) return

    const width = a.renderer.screen.width - SCROLLBAR_WIDTH
    const absX = headerWidth() + (transport.positionMs / 1000) * pxPerSecond.value

    // Auto-follow during playback OR while the user is dragging the playhead:
    // once the head crosses the viewport midpoint, scroll the content so it
    // stays pinned at the centre. `clampScroll()` will cap `scrollX` at the
    // end of the timeline content, so once the scroll has reached the end
    // the head naturally continues toward the right edge.
    if (transport.isPlaying || isDraggingPlayhead.value) {
        const viewportCentre = headerWidth() + (width - headerWidth()) / 2
        const desired = Math.max(0, absX - viewportCentre)
        if (Math.abs(desired - scrollX.value) > 0.5) {
            scrollX.value = desired
            clampScroll()
            redraw()
        }
    }

    playhead.removeChildren()

    const trackN = project.tracks.length
    if (trackN === 0) {
        // No tracks → nothing to draw, including no drop ghost.
        return
    }

    const x = absX - scrollX.value
    const playheadOnScreen = x >= headerWidth() && x <= width

    if (playheadOnScreen) {
        // Line spans the ruler + exactly the visible track rows, clipped to
        // the bottom of the visible track area so it never crosses into the
        // horizontal-scrollbar lane.
        const tracksHeight = tracksContentHeight.value
        const bottomY = Math.min(
            RULER_HEIGHT + trackAreaHeight.value,
            RULER_HEIGHT + tracksHeight - scrollY.value
        )

        const g = new G()

        // Vertical line.
        g.moveTo(x + 0.5, 0).lineTo(x + 0.5, bottomY).stroke({ color: PLAYHEAD, width: 1, alpha: 0.9 })

        // Small triangular heads at each end so the playhead is easy to spot.
        // Top: points down into the ruler. Bottom: points up from the end of
        // the visible track area (or the project end if it's higher up).
        const headW = 8
        g.poly([x - headW / 2, 0, x + headW / 2, 0, x, headW]).fill({ color: PLAYHEAD, alpha: 0.95 })
        g.poly([
            x - headW / 2, bottomY,
            x + headW / 2, bottomY,
            x, bottomY - headW
        ]).fill({ color: PLAYHEAD, alpha: 0.95 })

        playhead.addChild(g)
    }

    // Drop-preview ghost — drawn on top of the playhead regardless of
    // whether the playhead itself is currently visible. Shown while a
    // library item is being dragged over a valid track row; green for "OK
    // to drop", red for "would overlap".
    if (dropPreview.value) drawDropPreview()
}

/**
 * Render the translucent rectangle showing where a dragged library item
 * would land. Coordinates are in viewport space; `dropPreview` itself is in
 * timeline units (track index + ms) so the ghost stays correct as the
 * user scrolls / zooms.
 */
function drawDropPreview(): void {
    const a = app.value
    const playhead = playheadLayer.value
    const G = GraphicsCtor.value
    const dp = dropPreview.value
    if (!a || !playhead || !G || !dp) return

    if (dp.trackIndex < 0 || dp.trackIndex >= project.tracks.length) return

    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    const yTop = RULER_HEIGHT + dp.trackIndex * (TRACK_HEIGHT + TRACK_GAP) - scrollY.value
    // Off-screen vertically — skip.
    if (yTop + TRACK_HEIGHT <= RULER_HEIGHT) return
    if (yTop >= a.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0)) return

    const absLeft = headerWidth() + (dp.startMs / 1000) * pxPerSecond.value
    const width = Math.max(2, (dp.durationMs / 1000) * pxPerSecond.value)
    const xLeft = absLeft - scrollX.value
    const xRight = xLeft + width
    if (xRight <= headerWidth() || xLeft >= rightEdge) return

    // Clip horizontally so the ghost never spills over the header column or
    // the right scrollbar lane.
    const clippedLeft = Math.max(headerWidth(), xLeft)
    const clippedRight = Math.min(rightEdge, xRight)
    const w = clippedRight - clippedLeft
    if (w <= 0) return

    // Clip vertically against the bottom-of-tracks-area as well.
    const bottomLimit = Math.min(
        a.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0),
        RULER_HEIGHT + trackAreaHeight.value
    )
    const clippedTop = Math.max(RULER_HEIGHT, yTop)
    const clippedBottom = Math.min(bottomLimit, yTop + TRACK_HEIGHT)
    const h = clippedBottom - clippedTop
    if (h <= 0) return

    const colour = dp.valid ? 0x22c55e : 0xef4444 // green-500 / red-500

    const g = new G()
    g.rect(clippedLeft, clippedTop, w, h).fill({ color: colour, alpha: 0.18 })
    g.rect(clippedLeft + 0.5, clippedTop + 0.5, w - 1, h - 1).stroke({
        color: colour,
        width: 1.5,
        alpha: 0.9
    })
    playhead.addChild(g)
}

/**
 * Mouse-wheel zoom. The wheel adjusts horizontal zoom (`pxPerSecond`) using
 * an exponential factor so equal-magnitude wheel deltas give symmetric zoom
 * in / out. Zoom anchors on the time under the pointer so the bar / clip
 * the user is hovering stays fixed on screen. Outside the track-content
 * area (over the header column or scrollbar lanes) the zoom anchors on the
 * left edge of the track area instead.
 *
 * Vertical / horizontal scroll is reachable via the scrollbars and (later)
 * other dedicated controls.
 */
function onWheel(e: WheelEvent): void {
    if (!host.value) return
    e.preventDefault()
    // Zoom is meaningless until there's something on the timeline. Disabling
    // it on an empty project also prevents the ruler grid scale shifting
    // around before the user has any visual reference to anchor it to.
    if (project.tracks.length === 0) return
    const delta = e.deltaY || e.deltaX
    if (delta === 0) return

    // Exponential zoom factor. ~ ±100 delta per wheel notch on most mice
    // gives ~1.16× / 0.86× per notch which feels brisk but controlled.
    const factor = Math.pow(1.0015, -delta)
    const prev = pxPerSecond.value
    const next = geometry.setPxPerSecond(prev * factor)
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

// ----- Scrollbar drag handling -----------------------------------------------
//
// We don't use a native <input type="range"> or browser scrollbar because we
// want pixel-precise control over thumb size and visual style. PointerEvents
// give us a single code path for mouse + trackpad + (future) touch.

let dragStartPointerX = 0
let dragStartScrollX = 0
let draggingPointerId: number | null = null
const scrollbarTrack = ref<HTMLDivElement | null>(null)

function onThumbPointerDown(e: PointerEvent): void {
    if (!showScrollbar.value) return
    e.preventDefault()
    draggingPointerId = e.pointerId
    dragStartPointerX = e.clientX
    dragStartScrollX = scrollX.value
        ; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onThumbPointerMove(e: PointerEvent): void {
    if (draggingPointerId !== e.pointerId) return
    const travel = trackAreaWidth.value - thumbWidthPx.value
    if (travel <= 0) return
    const deltaPx = e.clientX - dragStartPointerX
    // Map thumb travel → content travel.
    const scrollDelta = (deltaPx / travel) * maxScrollX.value
    const next = Math.min(maxScrollX.value, Math.max(0, dragStartScrollX + scrollDelta))
    if (next === scrollX.value) return
    scrollX.value = next
    redraw()
    updatePlayhead()
}

function onThumbPointerUp(e: PointerEvent): void {
    if (draggingPointerId !== e.pointerId) return
    draggingPointerId = null
        ; (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
}

/**
 * Click on the scrollbar track (not the thumb) → jump so the thumb is
 * centred under the click. Mirrors native scrollbar behaviour for "page
 * to here".
 */
function onTrackPointerDown(e: PointerEvent): void {
    if (!showScrollbar.value || !scrollbarTrack.value) return
    const rect = scrollbarTrack.value.getBoundingClientRect()
    const localX = e.clientX - rect.left
    const travel = trackAreaWidth.value - thumbWidthPx.value
    if (travel <= 0) return
    const targetThumbLeft = Math.min(travel, Math.max(0, localX - thumbWidthPx.value / 2))
    const next = (targetThumbLeft / travel) * maxScrollX.value
    scrollX.value = next
    redraw()
    updatePlayhead()
}

// --- Vertical scrollbar handlers (mirror the horizontal ones) --------------

let vDragStartPointerY = 0
let vDragStartScrollY = 0
let vDraggingPointerId: number | null = null
const vScrollbarTrack = ref<HTMLDivElement | null>(null)

function onVThumbPointerDown(e: PointerEvent): void {
    if (maxScrollY.value === 0) return
    e.preventDefault()
    vDraggingPointerId = e.pointerId
    vDragStartPointerY = e.clientY
    vDragStartScrollY = scrollY.value
        ; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onVThumbPointerMove(e: PointerEvent): void {
    if (vDraggingPointerId !== e.pointerId) return
    const travel = vLaneHeight.value - vThumbHeightPx.value
    if (travel <= 0) return
    const deltaPx = e.clientY - vDragStartPointerY
    const scrollDelta = (deltaPx / travel) * maxScrollY.value
    const next = Math.min(maxScrollY.value, Math.max(0, vDragStartScrollY + scrollDelta))
    if (next === scrollY.value) return
    scrollY.value = next
    redraw()
    updatePlayhead()
}

function onVThumbPointerUp(e: PointerEvent): void {
    if (vDraggingPointerId !== e.pointerId) return
    vDraggingPointerId = null
        ; (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
}

function onVTrackPointerDown(e: PointerEvent): void {
    if (maxScrollY.value === 0 || !vScrollbarTrack.value) return
    const rect = vScrollbarTrack.value.getBoundingClientRect()
    const localY = e.clientY - rect.top
    const travel = vLaneHeight.value - vThumbHeightPx.value
    if (travel <= 0) return
    const targetThumbTop = Math.min(travel, Math.max(0, localY - vThumbHeightPx.value / 2))
    const next = (targetThumbTop / travel) * maxScrollY.value
    scrollY.value = next
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
    />

    <!-- HTML overlay for track headers (name + M/S/X buttons). -->
    <TrackHeaderPanel :scroll-y="scrollY" />

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
      Add a track to start
    </div>
  </div>
</template>
