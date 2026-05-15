<script setup lang="ts">
// Timeline canvas. Renders track rows with their clips' waveforms.
//
// Implementation notes:
// - PixiJS v8 Application with WebGL preferred (falls back to WebGPU/canvas).
// - One Container per track row; clips are drawn into a single Graphics per
//   clip (cheap, since clips redraw only when the underlying clip changes).
// - The whole layout repaints on resize, track count change, or zoom change.
// - Time-axis is left-to-right. Horizontal zoom is driven by the reactive
//   `pxPerSecond` ref (currently mouse-wheel only; other controls TBC).

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Application, Container, Graphics, Text } from 'pixi.js'
import { useProjectStore, type Clip, TRACK_PALETTE } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useUiStore } from '@/stores/uiStore'
import { PEAKS_PER_SECOND } from '@/lib/audio'
import { send as sendBridge } from '@/lib/bridgeService'
import TrackHeaderPanel from '@/components/TrackHeaderPanel.vue'

const project = useProjectStore()
const transport = useTransportStore()
const library = useLibraryStore()
const ui = useUiStore()
const host = ref<HTMLDivElement | null>(null)

// Layout constants.
// Horizontal zoom. `pxPerSecond` is reactive so changing it (via the wheel
// handler below) causes all derived widths/positions to recompute on the
// next `redraw()`. The min/max cap prevent zooming to either a sliver or
// hundreds-of-pixels-per-second extremes where the waveform decimation
// breaks down.
const DEFAULT_PX_PER_SECOND = 60
const MIN_PX_PER_SECOND = 10
const MAX_PX_PER_SECOND = 480
const pxPerSecond = ref(DEFAULT_PX_PER_SECOND)
const TRACK_HEIGHT = 96
const TRACK_GAP = 4
// Track-header column width is a *user-resizable* layout pref held on
// `uiStore`. Pixi-side code reads it via `headerWidth()` so every redraw
// reflects the current value; `watch(headerWidthRef, redraw)` further
// down repaints the canvas whenever the user drags the divider.
const headerWidth = (): number => ui.trackHeaderWidth
const headerWidthRef = computed(() => ui.trackHeaderWidth)
const RULER_HEIGHT = 28

// Musical grid. The BPM comes from `transportStore` so the user can edit
// it from the TransportBar; the grid + snap unit re-derive on the next
// redraw. SUBDIVISIONS_PER_BEAT=4 means quarter-beat resolution (i.e.
// 16th notes in 4/4), which is the coarsest snap target we want to
// support without making the grid too dense.
const TIME_SIG_NUM = 4
const SUBDIVISIONS_PER_BEAT = 4

// Theme (matches tailwind zinc palette).
// The track-header column shares the transport bar's `bg-zinc-900` so the
// chrome reads as one continuous surface, while the timeline canvas itself
// stays a shade darker (`zinc-950`) to keep the editable area visually
// distinct from the surrounding UI.
const BG = 0x09090b // zinc-950 (timeline canvas)
const TRACK_BG = 0x18181b // zinc-900
const TRACK_HEADER_BG = 0x18181b // zinc-900 (matches TransportBar)
const RULER_BG = 0x18181b
const RULER_TICK = 0x52525b // zinc-600 (ruler baseline + header divider)
const RULER_LABEL_HINT = 0xa1a1aa // zinc-400 (bar-number labels)
// Three-tier grid hierarchy: bar lines the brightest, beat lines mid,
// sub-beat (quarter-beat) lines faintest. Used in both the ruler ticks and
// the full-height background grid.
const GRID_BAR = 0x71717a // zinc-500
const GRID_BEAT = 0x52525b // zinc-600
const GRID_SUB = 0x3f3f46 // zinc-700
// (Per-track clip / waveform colours now come from TRACK_PALETTE; see projectStore.ts.)
const PLAYHEAD = 0xef4444 // red-500

let app: Application | null = null
let resizeObserver: ResizeObserver | null = null
let rulerLayer: Container | null = null
let tracksLayer: Container | null = null
let headersLayer: Container | null = null
let playheadLayer: Container | null = null

// Viewport-space rectangles for every clip drawn in the last `redraw`.
// Used by the pointer-down handler to hit-test clips so dragging a clip
// takes priority over the playhead-seek drag. Repopulated every frame.
interface ClipHitRegion {
    clipId: string
    x: number
    y: number
    w: number
    h: number
}
const clipHitRegions: ClipHitRegion[] = []

// Horizontal scroll offset in pixels. The PixiJS canvas itself stays at the
// viewport size; we just translate what we draw inside it. The TrackHeaderPanel
// (HTML overlay) is unaffected by horizontal scroll, so the left column stays
// pinned.
//
// `scrollX` and `scrollY` are Vue refs so the HTML scrollbar overlays bind to
// them for thumb position. `viewportWidth` / `viewportHeight` are also
// reactive so scrollbar geometry (visible/hidden, thumb size) updates as the
// host element resizes.
const scrollX = ref(0)
const scrollY = ref(0)
const viewportWidth = ref(0)
const viewportHeight = ref(0)

// Reserved width of the vertical scrollbar lane and height of the horizontal
// one. The vertical lane is permanently reserved (always visible) to avoid
// layout jitter when content height changes; the horizontal lane is only
// reserved when the horizontal scrollbar is actually showing.
const SCROLLBAR_HEIGHT = 12
const SCROLLBAR_WIDTH = 12

// Total horizontal pixels of content past the header column.
const contentPx = computed(() => Math.max(0, (project.durationMs / 1000) * pxPerSecond.value))
// Width of the scrollable lane (excludes the fixed header column AND the
// permanently-reserved vertical scrollbar lane on the right).
const trackAreaWidth = computed(() => Math.max(0, viewportWidth.value - headerWidth() - SCROLLBAR_WIDTH))
// Pixels the user can scroll horizontally. 0 → content fits, hide the bar.
const maxScrollX = computed(() => Math.max(0, contentPx.value - trackAreaWidth.value))
const showScrollbar = computed(() => maxScrollX.value > 0)
const thumbWidthPx = computed(() => {
    if (!showScrollbar.value || contentPx.value === 0) return 0
    const ratio = trackAreaWidth.value / contentPx.value
    return Math.max(24, trackAreaWidth.value * ratio)
})
const thumbLeftPx = computed(() => {
    if (!showScrollbar.value) return 0
    const travel = trackAreaWidth.value - thumbWidthPx.value
    if (travel <= 0) return 0
    return (scrollX.value / maxScrollX.value) * travel
})

// --- Vertical scroll geometry ------------------------------------------------
// Pixel height of all track rows stacked vertically (excludes the ruler row).
const tracksContentHeight = computed(() => {
    const n = project.tracks.length
    if (n === 0) return 0
    return n * TRACK_HEIGHT + (n - 1) * TRACK_GAP
})
// Visible height available for track rows: full host minus ruler minus
// horizontal scrollbar lane (only when shown). Used for culling and for
// figuring out how much content overflows (`maxScrollY`).
const trackAreaHeight = computed(() => {
    const reservedBottom = showScrollbar.value ? SCROLLBAR_HEIGHT : 0
    return Math.max(0, viewportHeight.value - RULER_HEIGHT - reservedBottom)
})
// Visible length of the vertical scrollbar lane itself. The lane spans the
// full canvas height (over the ruler row and over the horizontal-scrollbar
// lane), so the thumb can travel from canvas top to canvas bottom and the
// scrollbar reads as a global "where am I" indicator rather than only
// covering the track-rows region.
const vLaneHeight = computed(() => viewportHeight.value)
const maxScrollY = computed(() => Math.max(0, tracksContentHeight.value - trackAreaHeight.value))
const vThumbHeightPx = computed(() => {
    if (vLaneHeight.value === 0) return 0
    if (tracksContentHeight.value <= trackAreaHeight.value || trackAreaHeight.value === 0) {
        // Content fits (or there's no track area at all) — thumb fills the
        // whole lane so the user can see the scrollbar is "at rest".
        return vLaneHeight.value
    }
    // Thumb size reflects what fraction of the content is currently visible,
    // projected onto the full lane height.
    const ratio = trackAreaHeight.value / tracksContentHeight.value
    return Math.max(24, vLaneHeight.value * ratio)
})
const vThumbTopPx = computed(() => {
    if (maxScrollY.value === 0) return 0
    const travel = vLaneHeight.value - vThumbHeightPx.value
    if (travel <= 0) return 0
    return (scrollY.value / maxScrollY.value) * travel
})
// Constructor handles populated after the dynamic pixi.js import resolves.
let GraphicsCtor: typeof Graphics | null = null
let ContainerCtor: typeof Container | null = null
let TextCtor: typeof Text | null = null

onMounted(async () => {
    if (!host.value) return

    // Lazy-load PixiJS so the title bar + transport bar render before the
    // ~500 KB pixi bundle finishes parsing. Also apply the CSP-safe shader
    // patch (Electron's renderer disallows `unsafe-eval`) before constructing
    // the WebGL renderer.
    // @ts-expect-error -- pixi.js/unsafe-eval has no published .d.ts; it's side-effect-only.
    await import('pixi.js/unsafe-eval')
    const pixi = await import('pixi.js')
    GraphicsCtor = pixi.Graphics
    ContainerCtor = pixi.Container
    TextCtor = pixi.Text

    // The component could have unmounted while pixi was loading.
    if (!host.value) return

    app = new pixi.Application()
    await app.init({
        background: BG,
        antialias: true,
        resizeTo: host.value,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1
    })

    // And again — component might have unmounted while init was awaiting.
    if (!host.value) {
        app.destroy(true, { children: true, texture: true })
        app = null
        return
    }

    host.value.appendChild(app.canvas)
    app.canvas.style.display = 'block'

    // Force the renderer to match the host's current layout size. PixiJS's
    // `resizeTo` reacts to window resize but not to flex/layout settling, and
    // during init the host may not yet have its final width. Without this the
    // draw-coordinate space can lag the canvas CSS size, leaving the right
    // ~25 % of the canvas empty of drawn content.
    const initW = host.value.clientWidth
    const initH = host.value.clientHeight
    if (initW > 0 && initH > 0) {
        app.renderer.resize(initW, initH)
        viewportWidth.value = initW
        viewportHeight.value = initH
    }

    // Mouse-wheel horizontal scrolling. Vertical wheel deltas translate to
    // horizontal scroll because the timeline has no vertical scroll surface.
    host.value.addEventListener('wheel', onWheel, { passive: false })

    // Playhead seek-drag: pointerdown anywhere on the timeline canvas (right
    // of the header column, above the horizontal scrollbar lane) starts a
    // drag that snaps to the nearest sub-beat (1/16 of a bar at 4/4).
    host.value.addEventListener('pointerdown', onPlayheadPointerDown)

    // Drag-and-drop landing zone for library items. The actual drag payload
    // is set on the library cards (`application/x-jackdaw-library-item`);
    // we just compute the target track + start time and update the ghost.
    host.value.addEventListener('dragenter', onTimelineDragEnter)
    host.value.addEventListener('dragover', onTimelineDragOver)
    host.value.addEventListener('dragleave', onTimelineDragLeave)
    host.value.addEventListener('drop', onTimelineDrop)

    rulerLayer = new ContainerCtor()
    tracksLayer = new ContainerCtor()
    // Headers drawn last so they sit above any scrolled clip content (future).
    headersLayer = new ContainerCtor()
    // Playhead sits above everything so it stays visible over clips and headers.
    playheadLayer = new ContainerCtor()

    app.stage.addChild(rulerLayer)
    app.stage.addChild(tracksLayer)
    app.stage.addChild(headersLayer)
    app.stage.addChild(playheadLayer)

    redraw()
    updatePlayhead()

    // PixiJS's `resizeTo` only reacts to window resize events, not to layout
    // changes of the host element. The host can change size when the parent
    // flex layout settles, when sibling bars (title/transport) reflow, or when
    // dev tools opens. We explicitly resize the renderer here so the draw
    // coordinate space matches the canvas's CSS size (otherwise the BG
    // clear-colour stretches via CSS but anything we draw stops at the stale
    // renderer width — typically ~75 % of the visible canvas).
    resizeObserver = new ResizeObserver(() => {
        if (!app || !host.value) return
        const w = host.value.clientWidth
        const h = host.value.clientHeight
        if (w > 0 && h > 0) {
            app.renderer.resize(w, h)
            viewportWidth.value = w
            viewportHeight.value = h
        }
        clampScroll()
        redraw()
        updatePlayhead()
    })
    resizeObserver.observe(host.value)
})

onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
    host.value?.removeEventListener('wheel', onWheel)
    host.value?.removeEventListener('pointerdown', onPlayheadPointerDown)
    host.value?.removeEventListener('dragenter', onTimelineDragEnter)
    host.value?.removeEventListener('dragover', onTimelineDragOver)
    host.value?.removeEventListener('dragleave', onTimelineDragLeave)
    host.value?.removeEventListener('drop', onTimelineDrop)
    window.removeEventListener('pointermove', onPlayheadPointerMove)
    window.removeEventListener('pointerup', onPlayheadPointerUp)
    window.removeEventListener('pointercancel', onPlayheadPointerUp)
    window.removeEventListener('pointermove', onClipPointerMove)
    window.removeEventListener('pointerup', onClipPointerUp)
    window.removeEventListener('pointercancel', onClipPointerUp)
    app?.destroy(true, { children: true, texture: true })
    app = null
    rulerLayer = null
    tracksLayer = null
    headersLayer = null
    playheadLayer = null
})

// Re-render whenever the project's track or clip count changes. Both track-
// add/remove and clip-import need to repaint: the former changes the row
// stack, the latter materialises a waveform on an existing row and may grow
// the track's `lengthMs` (which extends the timeline).
watch(
    () => [project.tracks.length, Object.keys(project.clips).length] as const,
    () => {
        redraw()
        updatePlayhead()
    }
)

// Move the playhead each time the backend pushes a new position (60 Hz).
// Also reset the scroll offset whenever the position rewinds to 0 — this
// covers both Stop and Back-to-Start, regardless of whether playback was
// active when the rewind happened.
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

// When the project gets longer/shorter (tracks added/removed, etc.) the
// content width changes — re-clamp scrollX so we never land past the end.
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
    if (!app || !rulerLayer || !tracksLayer || !headersLayer) return

    rulerLayer.removeChildren()
    tracksLayer.removeChildren()
    headersLayer.removeChildren()
    clipHitRegions.length = 0

    // `screen.width` is the renderer's logical (CSS-pixel) drawing-space
    // width — i.e. the width we should draw to in stage coordinates so that
    // content reaches the right edge of the canvas regardless of
    // devicePixelRatio.
    const width = app.renderer.screen.width

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
    if (!app || !headersLayer || !GraphicsCtor) return
    const bottom = app.renderer.screen.height
    const divider = new GraphicsCtor()
    divider
        .moveTo(headerWidth() - 0.5, 0)
        .lineTo(headerWidth() - 0.5, bottom)
        .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
    headersLayer.addChild(divider)
}

function drawRuler(width: number): void {
    if (!rulerLayer || !GraphicsCtor) return

    // Ruler stops short of the vertical scrollbar lane on the right.
    const rightEdge = width - SCROLLBAR_WIDTH

    const bg = new GraphicsCtor()
    bg.rect(0, 0, rightEdge, RULER_HEIGHT).fill(RULER_BG)
    bg.moveTo(0, RULER_HEIGHT - 0.5).lineTo(rightEdge, RULER_HEIGHT - 0.5).stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
    rulerLayer.addChild(bg)

    // Iterate quarter-beat (sub) indices in content-space, drawing into one
    // of three Graphics buckets by tier so each tier can have its own stroke
    // style applied in a single call.
    const pxPerBeat = (60 / transport.bpm) * pxPerSecond.value
    const pxPerSub = pxPerBeat / SUBDIVISIONS_PER_BEAT
    const subsPerBar = SUBDIVISIONS_PER_BEAT * TIME_SIG_NUM

    const firstSub = Math.max(0, Math.floor(scrollX.value / pxPerSub))
    const lastSub = Math.ceil((scrollX.value + (rightEdge - headerWidth())) / pxPerSub)

    const subTicks = new GraphicsCtor()
    const beatTicks = new GraphicsCtor()
    const barTicks = new GraphicsCtor()

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
    rulerLayer.addChild(subTicks)
    rulerLayer.addChild(beatTicks)
    rulerLayer.addChild(barTicks)

    // Bar-number labels centred above each bar line. Bars are 0-indexed,
    // so the first bar line (t=0) is labelled "0" and each subsequent
    // bar line increments by one — matching the Bar.Beat.Sub display in
    // the transport bar.
    if (TextCtor) {
        const startSub = Math.ceil(firstSub / subsPerBar) * subsPerBar
        for (let s = startSub; s <= lastSub; s += subsPerBar) {
            const x = headerWidth() + s * pxPerSub - scrollX.value + 0.5
            if (x < headerWidth() || x > rightEdge) continue
            const barNumber = s / subsPerBar
            const label = new TextCtor({
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
            rulerLayer.addChild(label)
        }
    }

    // Header column background sits in the ruler row too.
    const headerCorner = new GraphicsCtor()
    headerCorner.rect(0, 0, headerWidth(), RULER_HEIGHT).fill(TRACK_HEADER_BG)
    rulerLayer.addChild(headerCorner)
}

/**
 * Full-height vertical grid lines spanning the track area. Same musical
 * subdivisions as `drawRuler` (bar / beat / sub-beat) so the ruler ticks and
 * the grid stay visually aligned, allowing items to be placed at quarter-beat
 * resolution later. Drawn on `tracksLayer` between the row backgrounds and
 * the clip blocks so clips obscure the grid where they sit on top of it.
 */
function drawGrid(width: number): void {
    if (!tracksLayer || !GraphicsCtor) return

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

    const subLines = new GraphicsCtor()
    const beatLines = new GraphicsCtor()
    const barLines = new GraphicsCtor()

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

    tracksLayer.addChild(subLines)
    tracksLayer.addChild(beatLines)
    tracksLayer.addChild(barLines)
}

function drawTracks(width: number): void {
    if (!tracksLayer || !headersLayer || !GraphicsCtor || !app) return

    // Track rows live in the area between the ruler and the horizontal
    // scrollbar lane and to the left of the vertical scrollbar lane.
    const rightEdge = width - SCROLLBAR_WIDTH
    const visibleBottom = RULER_HEIGHT + trackAreaHeight.value

    // Full-height track-header column fill: ensures the left strip reads as
    // a continuous `zinc-900` panel (matching the TransportBar) even when
    // there are no tracks or the track list doesn't fill the viewport. The
    // per-row header rectangles drawn below sit on top of this, so the
    // colour is identical either way.
    const headerColumnBg = new GraphicsCtor()
    headerColumnBg
        .rect(0, RULER_HEIGHT, headerWidth(), app.renderer.screen.height - RULER_HEIGHT)
        .fill(TRACK_HEADER_BG)
    tracksLayer.addChild(headerColumnBg)

    // Pass 1: row backgrounds + headers. Collect visible rows so we can do a
    // second pass for clips AFTER the grid is drawn, ensuring clip blocks
    // visually sit on top of the grid lines.
    const tracks = project.tracks
    const visibleRows: { track: (typeof tracks)[number]; y: number }[] = []
    for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]
        const y = RULER_HEIGHT + i * (TRACK_HEIGHT + TRACK_GAP) - scrollY.value

        // Cull rows that are entirely outside the visible track area.
        if (y + TRACK_HEIGHT <= RULER_HEIGHT) continue
        if (y >= visibleBottom) break

        // Row background (clipped to the track area on the right so it doesn't
        // bleed under the vertical scrollbar lane).
        const rowBg = new GraphicsCtor()
        rowBg.rect(0, y, rightEdge, TRACK_HEIGHT).fill(TRACK_BG)
        tracksLayer.addChild(rowBg)

        // Track header.
        const header = new GraphicsCtor()
        header.rect(0, y, headerWidth(), TRACK_HEIGHT).fill(TRACK_HEADER_BG)
        header
            .moveTo(headerWidth() - 0.5, y)
            .lineTo(headerWidth() - 0.5, y + TRACK_HEIGHT)
            .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
        headersLayer.addChild(header)

        visibleRows.push({ track, y })
    }

    // Grid lines: drawn after row backgrounds and across the full visible
    // track area (even past the last row) so the time grid always fills the
    // canvas vertically. Must come BEFORE clip drawing below so clips overlay
    // the grid.
    drawGrid(width)

    // Pass 2: clips.
    for (const { track, y } of visibleRows) {
        const palette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]
        for (const clipId of track.clipIds) {
            const clip = project.clips[clipId]
            if (!clip) continue
            drawClip(clip, y, palette)
        }
    }
}

function drawClip(clip: Clip, rowY: number, palette: (typeof TRACK_PALETTE)[number]): void {
    if (!app || !tracksLayer || !GraphicsCtor) return

    const viewportWidthPx = app.renderer.screen.width - SCROLLBAR_WIDTH
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
    const block = new GraphicsCtor()
    block.roundRect(x, innerY, w, innerH, 4).fill({ color: palette.fill, alpha: 0.85 }).stroke({ color: palette.border, width: 1, alpha: 0.9 })
    tracksLayer.addChild(block)

    // Record the viewport-space rectangle so pointer-down can hit-test for
    // drag-to-move. The visible region (after culling) is enough.
    clipHitRegions.push({ clipId: clip.id, x, y: innerY, w, h: innerH })

    // Waveform. Only iterate the visible pixel range so very long clips don't
    // tank the framerate when zooming or scrolling.
    const wave = new GraphicsCtor()
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
            const lo = peaks[i * 2]
            const hi = peaks[i * 2 + 1]
            if (lo < min) min = lo
            if (hi > max) max = hi
        }

        // Skip silent columns (single-pixel-wide minimum to keep continuity).
        const yTop = midY + max * -half
        const yBot = midY + min * -half
        wave.moveTo(x + px + 0.5, yTop).lineTo(x + px + 0.5, yBot < yTop + 1 ? yTop + 1 : yBot)
    }
    wave.stroke({ color: palette.wave, width: 1, alpha: 0.95 })
    tracksLayer.addChild(wave)

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
    if (!tracksLayer || !GraphicsCtor || !TextCtor) return

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
    const headerBg = new GraphicsCtor()
    headerBg.rect(clipX, clipInnerY, desiredW, HEADER_H).fill({ color: palette.border, alpha: 0.95 })
    tracksLayer.addChild(headerBg)

    const label = new TextCtor({
        text,
        style: {
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: FONT_SIZE,
            fill: 0x09090b // zinc-950, high contrast against the bright header
        }
    })
    label.x = Math.round(clipX + PAD_X)
    label.y = Math.round(clipInnerY + (HEADER_H - FONT_SIZE) / 2 - 1)
    tracksLayer.addChild(label)
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
    if (!app || !playheadLayer || !GraphicsCtor) return

    const width = app.renderer.screen.width - SCROLLBAR_WIDTH
    const absX = headerWidth() + (transport.positionMs / 1000) * pxPerSecond.value

    // Auto-follow during playback OR while the user is dragging the playhead:
    // once the head crosses the viewport midpoint, scroll the content so it
    // stays pinned at the centre. `clampScroll()` will cap `scrollX` at the
    // end of the timeline content, so once the scroll has reached the end
    // the head naturally continues toward the right edge.
    if (transport.isPlaying || isDraggingPlayhead) {
        const viewportCentre = headerWidth() + (width - headerWidth()) / 2
        const desired = Math.max(0, absX - viewportCentre)
        if (Math.abs(desired - scrollX.value) > 0.5) {
            scrollX.value = desired
            clampScroll()
            redraw()
        }
    }

    playheadLayer.removeChildren()

    const trackCount = project.tracks.length
    if (trackCount === 0) {
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

        const g = new GraphicsCtor()

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

        playheadLayer.addChild(g)
    }

    // Drop-preview ghost — drawn on top of the playhead regardless of
    // whether the playhead itself is currently visible. Shown while a
    // library item is being dragged over a valid track row; green for "OK
    // to drop", red for "would overlap".
    if (dropPreview) drawDropPreview()
}

/**
 * Render the translucent rectangle showing where a dragged library item
 * would land. Coordinates are in viewport space; `dropPreview` itself is in
 * timeline units (track index + ms) so the ghost stays correct as the
 * user scrolls / zooms.
 */
function drawDropPreview(): void {
    if (!app || !playheadLayer || !GraphicsCtor || !dropPreview) return

    const dp = dropPreview
    if (dp.trackIndex < 0 || dp.trackIndex >= project.tracks.length) return

    const rightEdge = app.renderer.screen.width - SCROLLBAR_WIDTH
    const yTop = RULER_HEIGHT + dp.trackIndex * (TRACK_HEIGHT + TRACK_GAP) - scrollY.value
    // Off-screen vertically — skip.
    if (yTop + TRACK_HEIGHT <= RULER_HEIGHT) return
    if (yTop >= app.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0)) return

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
        app.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0),
        RULER_HEIGHT + trackAreaHeight.value
    )
    const clippedTop = Math.max(RULER_HEIGHT, yTop)
    const clippedBottom = Math.min(bottomLimit, yTop + TRACK_HEIGHT)
    const h = clippedBottom - clippedTop
    if (h <= 0) return

    const colour = dp.valid ? 0x22c55e : 0xef4444 // green-500 / red-500

    const g = new GraphicsCtor()
    g.rect(clippedLeft, clippedTop, w, h).fill({ color: colour, alpha: 0.18 })
    g.rect(clippedLeft + 0.5, clippedTop + 0.5, w - 1, h - 1).stroke({
        color: colour,
        width: 1.5,
        alpha: 0.9
    })
    playheadLayer.addChild(g)
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
    const next = Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, prev * factor))
    if (next === prev) return

    // Determine the anchor (in track-area-local pixels) and the time it
    // currently sits at, so we can re-pin the same time under the pointer
    // after applying the new zoom.
    const hostRect = host.value.getBoundingClientRect()
    const pointerXInHost = e.clientX - hostRect.left
    const trackLocalX = Math.max(0, Math.min(trackAreaWidth.value, pointerXInHost - headerWidth()))
    const timeAtAnchorSec = (scrollX.value + trackLocalX) / prev

    pxPerSecond.value = next

    // Re-anchor: solve for scrollX so the same time sits at the same
    // pointer-local x. `maxScrollX` is reactive on `pxPerSecond`, so by the
    // time we read it here it reflects the new zoom.
    const newScroll = timeAtAnchorSec * next - trackLocalX
    scrollX.value = Math.max(0, Math.min(maxScrollX.value, newScroll))

    redraw()
    updatePlayhead()
}

// -----------------------------------------------------------------------
// Playhead seek-drag.
//
// Pointer-down inside the timeline content area moves the playhead to the
// nearest snap point and starts a drag; pointer-move while the drag is
// active keeps re-seeking. Snap target is one sub-beat — i.e. 1/16 of a
// bar at 4/4 — derived from the project BPM.
// -----------------------------------------------------------------------
const MS_PER_SUB_BEAT = (): number => 60000 / (transport.bpm * SUBDIVISIONS_PER_BEAT)
let isDraggingPlayhead = false

// Active clip-drag state. Tracks the clip being moved and the ms offset
// within the clip where the user originally clicked, so the clip's leading
// edge follows the cursor minus that grab offset (then snaps to grid).
let draggedClipId: string | null = null
let clipGrabOffsetMs = 0

function pointerToSnappedMs(clientX: number): number | null {
    if (!host.value || !app) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const rightEdge = app.renderer.screen.width - SCROLLBAR_WIDTH
    if (x < headerWidth() || x > rightEdge) return null
    const trackLocalX = x - headerWidth()
    const rawMs = ((scrollX.value + trackLocalX) / pxPerSecond.value) * 1000
    const snap = MS_PER_SUB_BEAT()
    return Math.max(0, Math.round(rawMs / snap) * snap)
}

/**
 * Convert the pointer's viewport-X into an unsnapped timeline ms. Returns
 * `null` if the pointer is outside the track-content area. Used by clip
 * drag where we want raw ms (so we can subtract the grab offset before
 * snapping the clip's leading edge).
 */
function pointerToRawMs(clientX: number): number | null {
    if (!host.value || !app) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const rightEdge = app.renderer.screen.width - SCROLLBAR_WIDTH
    if (x < headerWidth() || x > rightEdge) return null
    return ((scrollX.value + x - headerWidth()) / pxPerSecond.value) * 1000
}

function seekTo(positionMs: number): void {
    transport.setPosition(positionMs)
    sendBridge('TRANSPORT_SEEK', { positionMs })
    updatePlayhead()
}

function hitTestClip(clientX: number, clientY: number): ClipHitRegion | null {
    if (!host.value) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    // Iterate in reverse so the top-most drawn clip wins if any ever overlap.
    for (let i = clipHitRegions.length - 1; i >= 0; i--) {
        const r = clipHitRegions[i]
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r
    }
    return null
}

function onPlayheadPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    if (project.tracks.length === 0) return
    if (!host.value || !app) return

    // Ignore clicks below the horizontal scrollbar lane so dragging the
    // scrollbar thumb doesn't double-trigger a seek.
    const rect = host.value.getBoundingClientRect()
    const y = e.clientY - rect.top
    const bottomLimit = app.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0)
    if (y > bottomLimit) return

    // Clip drag takes priority — if pointer is on a clip block, drag it.
    const hit = hitTestClip(e.clientX, e.clientY)
    if (hit) {
        const clip = project.clips[hit.clipId]
        if (clip) {
            const pointerMs = pointerToRawMs(e.clientX)
            if (pointerMs !== null) {
                draggedClipId = clip.id
                clipGrabOffsetMs = pointerMs - clip.startMs
                window.addEventListener('pointermove', onClipPointerMove)
                window.addEventListener('pointerup', onClipPointerUp)
                window.addEventListener('pointercancel', onClipPointerUp)
                e.preventDefault()
                return
            }
        }
    }

    const ms = pointerToSnappedMs(e.clientX)
    if (ms === null) return

    isDraggingPlayhead = true
    window.addEventListener('pointermove', onPlayheadPointerMove)
    window.addEventListener('pointerup', onPlayheadPointerUp)
    window.addEventListener('pointercancel', onPlayheadPointerUp)
    seekTo(ms)
    e.preventDefault()
}

function onPlayheadPointerMove(e: PointerEvent): void {
    if (!isDraggingPlayhead) return
    const ms = pointerToSnappedMs(e.clientX)
    if (ms === null) return
    if (ms === transport.positionMs) return
    seekTo(ms)
}

function onPlayheadPointerUp(_e: PointerEvent): void {
    if (!isDraggingPlayhead) return
    isDraggingPlayhead = false
    window.removeEventListener('pointermove', onPlayheadPointerMove)
    window.removeEventListener('pointerup', onPlayheadPointerUp)
    window.removeEventListener('pointercancel', onPlayheadPointerUp)
}

function onClipPointerMove(e: PointerEvent): void {
    if (draggedClipId === null) return
    const clip = project.clips[draggedClipId]
    if (!clip) return
    const pointerMs = pointerToRawMs(e.clientX)
    if (pointerMs === null) return

    const rawStartMs = pointerMs - clipGrabOffsetMs
    const snap = MS_PER_SUB_BEAT()
    const snapped = Math.max(0, Math.round(rawStartMs / snap) * snap)
    if (snapped === clip.startMs) return
    project.moveClip(clip.id, snapped)
    redraw()
    updatePlayhead()
}

function onClipPointerUp(_e: PointerEvent): void {
    if (draggedClipId === null) return
    draggedClipId = null
    window.removeEventListener('pointermove', onClipPointerMove)
    window.removeEventListener('pointerup', onClipPointerUp)
    window.removeEventListener('pointercancel', onClipPointerUp)
}

// ─── Drop handling: library items → timeline ──────────────────────────────
//
// When a library card is dragged onto the timeline canvas we compute the
// target track and start time on every `dragover`, render a translucent
// "ghost" rectangle at that position (green if valid, red if it would
// overlap an existing clip), and on `drop` route the placement through
// `projectStore.addClipFromLibrary`.

const MIME_LIBRARY_ITEM = 'application/x-jackdaw-library-item'

interface DropPreview {
    trackIndex: number
    startMs: number
    durationMs: number
    valid: boolean
}

let dropPreview: DropPreview | null = null

/**
 * True iff an in-app library drag is currently in flight. We rely on the
 * id parked on `libraryStore.currentDragItemId` by LibraryPanel's
 * `dragstart` handler rather than sniffing `dataTransfer.types` — Chromium
 * puts the DataTransfer in "protected mode" during `dragover`, which hides
 * custom MIME types and was making the drag fail silently. The MIME
 * payload is still set on the drag for round-trip compatibility (and is
 * used as the authoritative source on the final `drop` event).
 */
function isLibraryDrag(): boolean {
    return library.currentDragItemId !== null
}

/**
 * Inspect the in-flight drag to discover which library item is being
 * dragged. `dataTransfer.getData(MIME)` returns `''` during `dragover` for
 * security reasons, so we instead read the id that LibraryPanel parks on
 * `libraryStore.currentDragItemId` in its `dragstart` handler. `getData`
 * does work during the final `drop` event; the caller passes
 * `viaGetData = true` there as a more authoritative fallback.
 */
function resolveDragItem(
    e: DragEvent,
    viaGetData = false
): import('@/stores/libraryStore').LibraryItem | null {
    if (viaGetData) {
        const id = e.dataTransfer?.getData(MIME_LIBRARY_ITEM) ?? ''
        if (id) {
            const item = library.getItem(id)
            if (item) return item
        }
    }
    const liveId = library.currentDragItemId
    return liveId ? library.getItem(liveId) : null
}

/**
 * Convert a viewport-local pointer position into a target track index +
 * snapped start time. Returns null if the pointer falls outside the
 * scrollable track area, in the inter-track gap, or below the last track.
 */
function pointerToTrackDrop(clientX: number, clientY: number): { trackIndex: number; startMs: number } | null {
    if (!host.value || !app) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top

    const rightEdge = app.renderer.screen.width - SCROLLBAR_WIDTH
    if (x < headerWidth() || x > rightEdge) return null
    if (y < RULER_HEIGHT) return null
    const bottomLimit = app.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0)
    if (y > bottomLimit) return null

    const contentY = y + scrollY.value - RULER_HEIGHT
    const slot = TRACK_HEIGHT + TRACK_GAP
    const trackIndex = Math.floor(contentY / slot)
    if (trackIndex < 0 || trackIndex >= project.tracks.length) return null
    // Reject the inter-track gap so dropping between rows doesn't pick one
    // arbitrarily — the user has to land in the row proper.
    const yWithinSlot = contentY - trackIndex * slot
    if (yWithinSlot >= TRACK_HEIGHT) return null

    const trackLocalX = x - headerWidth()
    const rawMs = ((scrollX.value + trackLocalX) / pxPerSecond.value) * 1000
    const snap = MS_PER_SUB_BEAT()
    const startMs = Math.max(0, Math.round(rawMs / snap) * snap)
    return { trackIndex, startMs }
}

function onTimelineDragEnter(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()
}

function onTimelineDragOver(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()
    if (!e.dataTransfer) return

    const target = pointerToTrackDrop(e.clientX, e.clientY)
    const item = resolveDragItem(e)
    if (!target || !item) {
        e.dataTransfer.dropEffect = 'none'
        if (dropPreview !== null) {
            dropPreview = null
            updatePlayhead()
        }
        return
    }

    const overlaps = project.wouldClipOverlap(
        project.tracks[target.trackIndex].id,
        target.startMs,
        item.durationMs
    )
    e.dataTransfer.dropEffect = overlaps ? 'none' : 'copy'

    // Only re-render the ghost when the resolved drop changes; the
    // dragover event fires very frequently and `updatePlayhead` clears
    // and rebuilds the playhead layer.
    const next: DropPreview = {
        trackIndex: target.trackIndex,
        startMs: target.startMs,
        durationMs: item.durationMs,
        valid: !overlaps
    }
    if (
        dropPreview === null ||
        dropPreview.trackIndex !== next.trackIndex ||
        dropPreview.startMs !== next.startMs ||
        dropPreview.durationMs !== next.durationMs ||
        dropPreview.valid !== next.valid
    ) {
        dropPreview = next
        updatePlayhead()
    }
}

function onTimelineDragLeave(e: DragEvent): void {
    if (!isLibraryDrag()) return
    // Only clear when the drag actually leaves the host (not when crossing
    // between child elements). `relatedTarget === null` is the cross-window
    // case; `!host.contains(relatedTarget)` covers leaving the host bounds.
    const related = e.relatedTarget as Node | null
    if (related && host.value && host.value.contains(related)) return
    if (dropPreview !== null) {
        dropPreview = null
        updatePlayhead()
    }
}

function onTimelineDrop(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()

    // Clear the ghost first so the timeline doesn't briefly show the old
    // preview after the drop completes.
    dropPreview = null

    // Prefer the dataTransfer payload (authoritative on `drop`); fall back
    // to the store-tracked id if the MIME data was somehow empty.
    const item = resolveDragItem(e, true)
    if (!item) {
        updatePlayhead()
        return
    }

    const target = pointerToTrackDrop(e.clientX, e.clientY)
    if (!target) {
        updatePlayhead()
        return
    }

    project.addClipFromLibrary(project.tracks[target.trackIndex].id, item, target.startMs)
    updatePlayhead()
}

/**
 * Clamp `scrollX` / `scrollY` to their valid ranges (e.g. after resize,
 * after a track is removed, etc.). Returns true if either value actually
 * changed so the caller can decide whether to repaint.
 */
function clampScroll(): boolean {
    let changed = false
    const clampedX = Math.min(maxScrollX.value, Math.max(0, scrollX.value))
    if (clampedX !== scrollX.value) {
        scrollX.value = clampedX
        changed = true
    }
    const clampedY = Math.min(maxScrollY.value, Math.max(0, scrollY.value))
    if (clampedY !== scrollY.value) {
        scrollY.value = clampedY
        changed = true
    }
    return changed
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
        <div ref="host" class="absolute inset-0" />

        <!-- HTML overlay for track headers (name + M/S/X buttons). -->
        <TrackHeaderPanel :scroll-y="scrollY" />

        <!-- Vertical divider drag handle. Sits on top of the column boundary
             between the track-header panel and the timeline canvas. The
             visible line is 1px (drawn by Pixi); this hit area is 6px wide
             and straddles the seam so it's easy to grab. -->
        <div class="absolute inset-y-0 z-20 w-1.5 cursor-col-resize" :style="{ left: (headerWidth() - 3) + 'px' }"
            title="Drag to resize track header column" @pointerdown="onHeaderResizePointerDown"
            @pointermove="onHeaderResizePointerMove" @pointerup="onHeaderResizePointerUp"
            @pointercancel="onHeaderResizePointerUp" />

        <!-- Vertical scrollbar lane. Spans the full canvas height (over the
             ruler row at the top and over the corner above the horizontal
             scrollbar at the bottom) so the thumb travels the entire canvas.
             The thumb only becomes interactive when there's overflow
             (`maxScrollY > 0`). -->
        <div ref="vScrollbarTrack" class="absolute inset-y-0 right-0 bg-zinc-900/80"
            :class="maxScrollY > 0 ? 'cursor-pointer' : ''" :style="{
                width: SCROLLBAR_WIDTH + 'px'
            }" @pointerdown="onVTrackPointerDown">
            <div v-if="maxScrollY > 0"
                class="absolute left-1 w-2 cursor-grab rounded-full bg-zinc-500 hover:bg-zinc-400 active:cursor-grabbing active:bg-zinc-300"
                :style="{ top: vThumbTopPx + 'px', height: vThumbHeightPx + 'px' }" @pointerdown="onVThumbPointerDown"
                @pointermove="onVThumbPointerMove" @pointerup="onVThumbPointerUp" @pointercancel="onVThumbPointerUp" />
        </div>

        <!-- Horizontal scrollbar. Sits above the transport bar (which lives
             outside this component) and to the right of the track header
             column. Only rendered when content overflows the viewport. -->
        <div v-if="showScrollbar" ref="scrollbarTrack" class="absolute bottom-0 cursor-pointer bg-zinc-900/80" :style="{
            left: headerWidth() + 'px',
            right: SCROLLBAR_WIDTH + 'px',
            height: SCROLLBAR_HEIGHT + 'px'
        }" @pointerdown="onTrackPointerDown">
            <div class="absolute top-1 h-2 cursor-grab rounded-full bg-zinc-500 hover:bg-zinc-400 active:cursor-grabbing active:bg-zinc-300"
                :style="{ left: thumbLeftPx + 'px', width: thumbWidthPx + 'px' }" @pointerdown="onThumbPointerDown"
                @pointermove="onThumbPointerMove" @pointerup="onThumbPointerUp" @pointercancel="onThumbPointerUp" />
        </div>

        <!-- Empty state hint. -->
        <div v-if="project.tracks.length === 0"
            class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
            Add a track to start
        </div>
    </div>
</template>
