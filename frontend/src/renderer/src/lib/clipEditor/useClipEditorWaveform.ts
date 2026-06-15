// Clip Editor waveform renderer (PixiJS) and hi-res peak request adapter.
//
// Mirrors the timeline renderer: the waveform is a batched Pixi `Mesh`, static
// chrome and time-anchored content live on separate layers, and horizontal
// scroll/playback translate the already-built band (an O(1) layer move) instead
// of repainting. A full `redraw()` only runs on content, zoom, selection or
// scroll-past-the-overscan changes; the playhead moves every frame for free.
// Inputs are getters so imperative draws read current reactive values.
import type { Container, Graphics, Text } from 'pixi.js'
import type { Ref } from 'vue'
import { send as sendBridge } from '@/lib/bridgeService'
import { pickPeaksLod } from '@/lib/peaksLod'
import { envelopeGainAtMs } from '@/lib/envelope'
import { overlayGainToY, volumeOverlayLanes, volumeTimeToSourceMs } from '@/lib/clipEditor/volumeOverlay'
import { createRedrawScheduler } from '@/lib/timeline/useRedrawScheduler'
import { exceedsRebuildThreshold, horizontalOverscanPx } from '@/lib/timeline/timelineWindow'
import {
  createWaveformRunMerger,
  waveformColumnDown,
  waveformColumnUp
} from '@/lib/timeline/waveformColumn'
import { createWaveMeshBuilder } from '@/lib/clipEditor/clipEditorWaveMesh'
import { useClipEditorScene } from '@/lib/clipEditor/useClipEditorScene'
import type {
  EditorHiResPeaks,
  ItemChannelPeaks,
  LibraryItem
} from '@/stores/libraryStore'
import type { ClipEnvelopePoint } from '@shared/bridge-protocol'

/** Backend rendering resolution requested when the user zooms in. */
const EDITOR_HI_RES_PEAKS_PER_SECOND = 2000
/** Minimum CSS-px height for each stacked stereo lane. */
const EDITOR_MIN_STEREO_LANE_PX = 24
const EDITOR_HI_RES_ZOOM_THRESHOLD = 4
/** Ruler band height in CSS pixels. */
const RULER_H = 18

// Theme (matches the previous Canvas-2D renderer so the look is unchanged).
const COL_RULER_BG = 0x18181b
const COL_RULER_BORDER = 0x27272a
const COL_RULER_TICK = 0x3f3f46
const COL_RULER_LABEL = 0xa1a1aa
const COL_BASELINE = 0x27272a
const COL_WAVE = 0x3b82f6
const COL_BEAT = 0xfacc15
const COL_SELECTION = 0x3b82f6
const COL_PLAYHEAD = 0xf97316
const COL_VOL_UNITY = 0x3f3f46
const COL_VOL_LINE = 0xa78bfa
const COL_VOL_ENDPOINT = 0x8b5cf6
const COL_VOL_MIDPOINT = 0xc4b5fd
const COL_VOL_MIDPOINT_DIM = 0xc4b5fd
const COL_VOL_DOT_STROKE = 0x2e1065

/** Fixed style for ruler labels so pooled Text only re-renders on content change. */
const RULER_LABEL_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  fill: COL_RULER_LABEL
} as const

export interface ClipEditorWaveformDeps {
  sourceItem: () => LibraryItem | null
  sourceDurationMs: () => number
  zoom: () => number
  visibleInMs: () => number
  visibleDurationMs: () => number
  visibleEndMs: () => number
  viewInMs: () => number
  viewEndMs: () => number
  selectionInMs: () => number
  selectionEndMs: () => number
  selectionDurationMs: () => number
  editsExistingClip: () => boolean
  playheadAbsMs: () => number
  volumeShapeAvailable: () => boolean
  volumeEditActive: () => boolean
  volumeShapeDurationMs: () => number
  draftPoints: () => readonly ClipEnvelopePoint[]
  draftEffectiveRatio: () => number
  draftReversed: () => boolean
  editorHiResPeaks: () => EditorHiResPeaks | null
  channelPeaksByItemId: () => Record<string, ItemChannelPeaks>
  waveformDisplayMode: () => 'summary' | 'stereo'
  /** Last-rendered lane layout, used by pointer hit testing. */
  waveformStereoLanes: Ref<boolean>
  /** CSS-pixel canvas width, kept in sync with the renderer for viewport maths. */
  canvasCssWidth: Ref<number>
}

export interface ClipEditorWaveform {
  /** Schedule a full scene rebuild (content / zoom / selection / volume changes). */
  drawWaveform: () => void
  /** Cheap per-frame update: translate for scroll (or rebuild past overscan) + playhead. */
  applyScroll: () => void
  /** Cheap per-frame playhead reposition with no scene rebuild. */
  updatePlayhead: () => void
  /** Build the Pixi app on the dialog host (call when the editor opens). */
  mountScene: (host: HTMLElement) => Promise<void>
  /** Tear the Pixi app down (call when the editor closes). */
  unmountScene: () => void
  /** The Pixi-managed canvas element for pointer hit-testing. */
  getCanvas: () => HTMLCanvasElement | null
  ensureEditorHiResPeaks: () => void
  resetHiResRequestKey: () => void
}

interface SceneGeometry {
  W: number
  H: number
  vDur: number
  viewIn: number
  viewEnd: number
  worldPxPerMs: number
  scrollPx: number
  worldW: number
  waveTop: number
  waveH: number
  waveMid: number
}

export function useClipEditorWaveform(deps: ClipEditorWaveformDeps): ClipEditorWaveform {
  let lastHiResRequestKey = ''
  // Horizontal scroll position (world px) the current band was built at; NaN
  // until the first draw, which forces the initial rebuild.
  let lastBuiltScrollPx = Number.NaN

  // Reusable chrome objects. `redraw()` detaches every child via the layers'
  // `removeChildren()` (which does NOT destroy them) and re-acquires from these
  // pools in draw order, so a rebuild — which at high zoom runs almost every
  // frame — does no Graphics/Text allocation or GPU teardown churn.
  const graphicsPool: Graphics[] = []
  let gfxCursor = 0
  const textPool: Text[] = []
  let textCursor = 0

  const scene = useClipEditorScene({
    onReady: () => {
      deps.canvasCssWidth.value = scene.screenWidth()
      scheduler.schedule()
    },
    onResize: (w) => {
      deps.canvasCssWidth.value = w
      scheduler.schedule()
    }
  })

  const meshBuilder = createWaveMeshBuilder({
    get MeshCtor() {
      return scene.MeshCtor.value
    },
    get MeshGeometryCtor() {
      return scene.MeshGeometryCtor.value
    },
    get whiteTexture() {
      return scene.whiteTexture.value
    }
  })

  const scheduler = createRedrawScheduler(() => redraw())

  function getCanvas(): HTMLCanvasElement | null {
    return scene.getCanvas()
  }

  async function mountScene(host: HTMLElement): Promise<void> {
    await scene.mount(host)
  }

  function unmountScene(): void {
    playheadGfx = null
    playheadGfxHeight = -1
    lastBuiltScrollPx = Number.NaN
    // The Pixi app teardown destroys these pooled objects; forget them so the
    // next mount rebuilds fresh instances rather than reusing destroyed ones.
    graphicsPool.length = 0
    textPool.length = 0
    meshBuilder.dropPool()
    scheduler.cancel()
    scene.unmount()
  }

  function resetHiResRequestKey(): void {
    lastHiResRequestKey = ''
  }

  function ensureEditorHiResPeaks(): void {
    const src = deps.sourceItem()
    if (!src) return
    if (deps.zoom() < EDITOR_HI_RES_ZOOM_THRESHOLD) return
    const existing = deps.editorHiResPeaks()
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

  /** Current scene geometry derived from reactive viewport state. */
  function computeGeometry(): SceneGeometry {
    const W = scene.screenWidth()
    const H = scene.screenHeight()
    const vDur = deps.visibleDurationMs()
    const viewIn = deps.viewInMs()
    const viewEnd = deps.viewEndMs()
    const vIn = deps.visibleInMs()
    const worldPxPerMs = vDur > 0 ? W / vDur : 0
    const scrollPx = (vIn - viewIn) * worldPxPerMs
    const waveTop = RULER_H
    const waveH = Math.max(0, H - RULER_H)
    return {
      W,
      H,
      vDur,
      viewIn,
      viewEnd,
      worldPxPerMs,
      scrollPx,
      worldW: Math.max(0, viewEnd - viewIn) * worldPxPerMs,
      waveTop,
      waveH,
      waveMid: waveTop + waveH / 2
    }
  }

  /** Detach (without destroying) all pooled chrome/mesh children before a redraw. */
  function beginFrame(): void {
    scene.rulerBgLayer.value?.removeChildren()
    scene.worldLayer.value?.removeChildren()
    scene.rulerTicksLayer.value?.removeChildren()
    gfxCursor = 0
    textCursor = 0
    meshBuilder.beginFrame()
  }

  /** A cleared, reusable Graphics from the pool (grows to the busiest frame). */
  function acquireGraphics(): Graphics | null {
    const G = scene.GraphicsCtor.value
    if (!G) return null
    const existing = graphicsPool[gfxCursor]
    if (existing && !existing.destroyed) {
      existing.clear()
      gfxCursor++
      return existing
    }
    const created = new G()
    graphicsPool[gfxCursor] = created
    gfxCursor++
    return created
  }

  /** A reusable Text from the pool with its content set (style is fixed). */
  function acquireText(text: string): Text | null {
    const T = scene.TextCtor.value
    if (!T) return null
    const existing = textPool[textCursor]
    if (existing && !existing.destroyed) {
      existing.text = text
      existing.visible = true
      textCursor++
      return existing
    }
    const created = new T({ text, style: RULER_LABEL_STYLE })
    textPool[textCursor] = created
    textCursor++
    return created
  }

  function redraw(): void {
    const world = scene.worldLayer.value
    const rulerBg = scene.rulerBgLayer.value
    const rulerTicks = scene.rulerTicksLayer.value
    if (!scene.isReady.value || !world || !rulerBg || !rulerTicks) return

    beginFrame()

    const src = deps.sourceItem()
    const g = computeGeometry()
    if (!src || g.W <= 0 || g.H <= 0 || g.vDur <= 0) return

    drawRulerBackground(rulerBg, g)
    drawWaveform(world, src, g)
    drawBeatGrid(world, src, g)
    drawRulerTicks(rulerTicks, g)
    drawSelection(world, g)
    drawVolumeOverlay(world, g)

    const sx = Math.round(g.scrollPx)
    world.x = -sx
    rulerTicks.x = -sx
    lastBuiltScrollPx = g.scrollPx
    updatePlayhead()
  }

  /** Translate the built band for scroll, or rebuild once it drifts too far. */
  function applyScroll(): void {
    const world = scene.worldLayer.value
    const rulerTicks = scene.rulerTicksLayer.value
    if (!scene.isReady.value || !world || !rulerTicks) return
    const g = computeGeometry()
    if (exceedsRebuildThreshold(g.scrollPx, lastBuiltScrollPx, g.W)) {
      scheduler.schedule()
      return
    }
    const sx = Math.round(g.scrollPx)
    world.x = -sx
    rulerTicks.x = -sx
    updatePlayhead()
  }

  // --- Ruler chrome (static layer, never translated) --------------------------
  function drawRulerBackground(layer: Container, g: SceneGeometry): void {
    const bg = acquireGraphics()
    if (!bg) return
    bg.rect(0, 0, g.W, RULER_H).fill(COL_RULER_BG)
    bg.moveTo(0, RULER_H - 0.5).lineTo(g.W, RULER_H - 0.5).stroke({ color: COL_RULER_BORDER, width: 1 })
    layer.addChild(bg)

    const baseline = acquireGraphics()
    if (!baseline) return
    baseline.moveTo(0, g.waveMid).lineTo(g.W, g.waveMid).stroke({ color: COL_BASELINE, width: 1 })
    layer.addChild(baseline)
  }

  // --- Ruler ticks + labels (world layer, translated) -------------------------
  function drawRulerTicks(layer: Container, g: SceneGeometry): void {
    const msPerPx = g.vDur / g.W
    const niceSteps = [
      50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000,
      120_000, 300_000, 600_000
    ]
    const desiredStep = 80 * msPerPx
    let majorMs = niceSteps[niceSteps.length - 1] ?? 1000
    for (const s of niceSteps) {
      if (s >= desiredStep) {
        majorMs = s
        break
      }
    }
    const minorMs = majorMs / 5
    const { fromMs, toMs } = bandMsRange(g)
    const firstMinor = Math.ceil(fromMs / minorMs) * minorMs

    const ticks = acquireGraphics()
    if (!ticks) return
    const labels: Text[] = []
    for (let t = firstMinor; t <= toMs + 0.0001; t += minorMs) {
      const x = Math.round(worldX(t, g)) + 0.5
      const isMajor = Math.abs(t / majorMs - Math.round(t / majorMs)) < 1e-6
      const tickH = isMajor ? 8 : 4
      ticks.moveTo(x, RULER_H - tickH).lineTo(x, RULER_H)
      if (isMajor) {
        const label = acquireText(formatRulerTime(t - g.viewIn, majorMs))
        if (label) {
          label.x = Math.round(x + 3)
          label.y = 2
          labels.push(label)
        }
      }
    }
    ticks.stroke({ color: COL_RULER_TICK, width: 1 })
    layer.addChild(ticks)
    for (const label of labels) layer.addChild(label)
  }

  // --- Waveform (batched mesh on the world layer) -----------------------------
  function drawWaveform(layer: Container, src: LibraryItem, g: SceneGeometry): void {
    const sourceTotal = deps.sourceDurationMs()
    const hiRes = deps.editorHiResPeaks()
    const usingHiRes = hiRes && hiRes.libraryItemId === src.id && hiRes.peaks.length >= 2
    const canvasPxPerSourceSec = g.worldPxPerMs * 1000

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

    const channelSourceId =
      src.kind === 'saved-clip' ? src.derivedFrom?.sourceItemId : src.id
    const hiResChannels =
      usingHiRes && hiRes!.channels.length === 2 ? hiRes!.channels : undefined
    const channelEntry = channelSourceId
      ? deps.channelPeaksByItemId()[channelSourceId]
      : undefined
    const stereoAvailable = !!hiResChannels || (!!channelEntry && channelEntry.channels.length === 2)
    const wantStereo =
      deps.waveformDisplayMode() === 'stereo' &&
      stereoAvailable &&
      g.waveH >= EDITOR_MIN_STEREO_LANE_PX * 2
    deps.waveformStereoLanes.value = wantStereo

    if (sourceTotal <= 0) return
    const reversed = deps.draftReversed()

    if (wantStereo) {
      const laneH = g.waveH / 2
      const laneHalfH = laneH / 2
      for (let ch = 0; ch < 2; ch++) {
        let lanePeaks: Float32Array
        let lanePps: number
        if (hiResChannels) {
          lanePeaks = hiResChannels[ch]!
          lanePps = hiRes!.peaksPerSecond
        } else {
          lanePeaks = channelEntry!.channels[ch]!
          lanePps = channelEntry!.peaksPerSecond
          const clod = channelEntry!.lod[ch]
          if (clod && clod.length > 0 && canvasPxPerSourceSec > 0) {
            const picked = pickPeaksLod(clod, canvasPxPerSourceSec)
            lanePeaks = picked.peaks
            lanePps = picked.peaksPerSecond
          }
        }
        buildWaveLane(layer, lanePeaks, lanePps, g.waveTop + laneH * ch + laneH / 2, laneHalfH, g, reversed, sourceTotal)
      }
    } else if (peaks && peaks.length >= 2) {
      buildWaveLane(layer, peaks, peaksPerSec, g.waveMid, g.waveH / 2, g, reversed, sourceTotal)
    }
  }

  function buildWaveLane(
    layer: Container,
    lanePeaks: Float32Array,
    lanePps: number,
    laneMidY: number,
    laneHalf: number,
    g: SceneGeometry,
    reversed: boolean,
    sourceTotal: number
  ): void {
    const pairs = Math.floor(lanePeaks.length / 2)
    if (pairs <= 0 || g.worldPxPerMs <= 0) return
    meshBuilder.reset()
    const overscan = horizontalOverscanPx(g.W)
    const from = Math.max(0, Math.floor(g.scrollPx - overscan))
    const to = Math.min(Math.ceil(g.worldW), Math.ceil(g.scrollPx + g.W + overscan))
    const msPerWorldPx = 1 / g.worldPxPerMs
    const useRate = lanePps > 0
    const merger = createWaveformRunMerger((sx, ex, yt, yb) => meshBuilder.pushQuad(sx, yt, ex, yb))

    for (let px = from; px < to; px++) {
      // Map the column's pixel span to a source-ms span so the aggregation
      // window matches the timeline; reversed clips read the window back-to-front.
      const edgeA = reversed ? g.viewEnd - px * msPerWorldPx : g.viewIn + px * msPerWorldPx
      const edgeB = reversed ? g.viewEnd - (px + 1) * msPerWorldPx : g.viewIn + (px + 1) * msPerWorldPx
      const loMs = Math.min(edgeA, edgeB)
      const hiMs = Math.max(edgeA, edgeB)

      let startIdx: number
      let endIdx: number
      if (useRate) {
        startIdx = Math.max(0, Math.floor((loMs / 1000) * lanePps))
        endIdx = Math.min(pairs, Math.max(startIdx + 1, Math.ceil((hiMs / 1000) * lanePps)))
      } else {
        const midIdx = Math.floor(((loMs + hiMs) / 2 / sourceTotal) * pairs)
        startIdx = Math.max(0, midIdx)
        endIdx = Math.min(pairs, startIdx + 1)
      }
      if (startIdx >= pairs) {
        merger.breakRun(px)
        continue
      }

      let min = 0
      let max = 0
      for (let i = startIdx; i < endIdx; i++) {
        const lo = lanePeaks[i * 2] || 0
        const hi = lanePeaks[i * 2 + 1] || 0
        if (lo < min) min = lo
        if (hi > max) max = hi
      }
      const yTop = laneMidY - waveformColumnUp(max, laneHalf, 1)
      const rawBot = laneMidY + waveformColumnDown(min, laneHalf, 1)
      const yBot = rawBot < yTop + 1 ? yTop + 1 : rawBot
      merger.push(px, yTop, yBot)
    }
    merger.finish(to)
    meshBuilder.flush(layer, COL_WAVE, 1)
  }

  // --- Beat grid (world layer) ------------------------------------------------
  function drawBeatGrid(layer: Container, src: LibraryItem, g: SceneGeometry): void {
    const sourceBpm = src.bpm
    const anchorSec = src.beatAnchorSec ?? src.beats?.[0]
    if (!sourceBpm || sourceBpm <= 0 || anchorSec === undefined) return
    const beatSpacingMs = (60 / sourceBpm) * 1000
    if (beatSpacingMs <= 0) return
    const anchorMs = anchorSec * 1000
    const { fromMs, toMs } = bandMsRange(g)
    let firstBeatMs = anchorMs + Math.ceil((fromMs - anchorMs) / beatSpacingMs) * beatSpacingMs
    while (firstBeatMs < fromMs) firstBeatMs += beatSpacingMs

    const lines = acquireGraphics()
    if (!lines) return
    const minPxSpacing = 4
    let lastX = Number.NEGATIVE_INFINITY
    for (let beatMs = firstBeatMs; beatMs <= toMs + 0.5; beatMs += beatSpacingMs) {
      const x = Math.round(worldX(beatMs, g)) + 0.5
      if (x - lastX < minPxSpacing) continue
      lines.moveTo(x, g.waveTop).lineTo(x, g.H)
      lastX = x
    }
    lines.stroke({ color: COL_BEAT, width: 1, alpha: 0.55 })
    layer.addChild(lines)
  }

  // --- Selection overlay (world layer) ----------------------------------------
  function drawSelection(layer: Container, g: SceneGeometry): void {
    const isSubSelection =
      deps.selectionInMs() > g.viewIn + 0.5 || deps.selectionEndMs() < g.viewEnd - 0.5
    const showHandles = !deps.editsExistingClip() || isSubSelection
    if (deps.selectionDurationMs() <= 0 || !showHandles) return

    const sx = worldX(deps.selectionInMs(), g)
    const ex = worldX(deps.selectionEndMs(), g)
    const handleW = 10
    const handleH = 8

    const fill = acquireGraphics()
    if (!fill) return
    fill.rect(sx, g.waveTop, ex - sx, g.waveH).fill({ color: COL_SELECTION, alpha: 0.18 })
    layer.addChild(fill)

    const edges = acquireGraphics()
    if (!edges) return
    edges.rect(sx - 1, 0, 2, g.H).fill(COL_SELECTION)
    edges.rect(ex - 1, 0, 2, g.H).fill(COL_SELECTION)
    // Inward triangles mark grabbable selection edges.
    edges.poly([sx, 0, sx + handleW, 0, sx, handleH]).fill(COL_SELECTION)
    edges.poly([sx, g.H, sx + handleW, g.H, sx, g.H - handleH]).fill(COL_SELECTION)
    edges.poly([ex, 0, ex - handleW, 0, ex, handleH]).fill(COL_SELECTION)
    edges.poly([ex, g.H, ex - handleW, g.H, ex, g.H - handleH]).fill(COL_SELECTION)
    layer.addChild(edges)
  }

  // --- Volume Shape (gain envelope) overlay (world layer) ----------------------
  function drawVolumeOverlay(layer: Container, g: SceneGeometry): void {
    if (!deps.volumeShapeAvailable()) return
    const points = deps.draftPoints()
    if (points.length < 2) return
    const editing = deps.volumeEditActive()
    const ratio = deps.draftEffectiveRatio() > 0 ? deps.draftEffectiveRatio() : 1
    const clipStartSourceMs = g.viewIn
    const durMs = deps.volumeShapeDurationMs()
    const envX = (timelineMs: number): number =>
      worldX(volumeTimeToSourceMs(timelineMs, clipStartSourceMs, ratio), g)
    const xStart = envX(0)
    const xEnd = envX(durMs)
    // `envX` is linear and monotonic in t, so its full extent (xEnd - xStart)
    // is the whole clip width in world px and grows with zoom. Clamp drawing to
    // the visible band + overscan and invert back to the timeline-ms window;
    // otherwise the unity/curve loops iterate over the entire clip every redraw,
    // which at high zoom stalls playback.
    const overscanPx = horizontalOverscanPx(g.W)
    const drawLeft = Math.max(xStart, g.scrollPx - overscanPx)
    const drawRight = Math.min(xEnd, g.scrollPx + g.W + overscanPx)
    if (drawRight <= drawLeft) return
    const tFromX = (x: number): number =>
      g.worldPxPerMs > 0
        ? (x / g.worldPxPerMs - clipStartSourceMs + g.viewIn) / ratio
        : 0
    const tLo = Math.max(0, Math.min(durMs, tFromX(drawLeft)))
    const tHi = Math.max(0, Math.min(durMs, tFromX(drawRight)))
    const steps = Math.max(1, Math.round((drawRight - drawLeft) / 3))
    const r = editing ? 4 : 2.5

    const lanes = volumeOverlayLanes(g.waveTop, g.waveH, deps.waveformStereoLanes.value)
    for (const lane of lanes) {
      const envY = (gain: number): number => overlayGainToY(gain, lane.top, lane.height)

      // Unity (0 dB) reference, drawn as a manual dashed line across the visible span.
      const uy = envY(1)
      const unity = acquireGraphics()
      if (!unity) return
      for (let x = drawLeft; x < drawRight; x += 6) {
        unity.moveTo(x, uy).lineTo(Math.min(x + 3, drawRight), uy)
      }
      unity.stroke({ color: COL_VOL_UNITY, width: 1, alpha: 0.9 })
      layer.addChild(unity)

      // Linear-in-dB segments curve in linear gain, sampled across the visible span.
      const curve = acquireGraphics()
      if (!curve) return
      for (let i = 0; i <= steps; i++) {
        const t = tLo + (i / steps) * (tHi - tLo)
        const x = envX(t)
        const y = envY(envelopeGainAtMs(points, t))
        if (i === 0) curve.moveTo(x, y)
        else curve.lineTo(x, y)
      }
      curve.stroke({ color: COL_VOL_LINE, width: editing ? 2 : 1.5, alpha: editing ? 0.95 : 0.5 })
      layer.addChild(curve)

      // Breakpoints are brighter and larger when editing (only those in view).
      for (let i = 0; i < points.length; i++) {
        const p = points[i]
        if (!p) continue
        const x = envX(p.timeMs)
        if (x < drawLeft - 8 || x > drawRight + 8) continue
        const y = envY(p.gain)
        const isEndpoint = i === 0 || i === points.length - 1
        const colour = editing
          ? isEndpoint
            ? COL_VOL_ENDPOINT
            : COL_VOL_MIDPOINT
          : COL_VOL_MIDPOINT_DIM
        const dot = acquireGraphics()
        if (!dot) return
        dot.circle(x, y, r).fill({ color: colour, alpha: editing ? 1 : 0.6 })
        if (editing) dot.stroke({ color: COL_VOL_DOT_STROKE, width: 1 })
        layer.addChild(dot)
      }
    }
  }

  // --- Playhead (viewport layer, moved every frame) ---------------------------
  let playheadGfx: Graphics | null = null
  let playheadGfxHeight = -1
  function ensurePlayheadGfx(height: number): Graphics | null {
    const layer = scene.playheadLayer.value
    const G = scene.GraphicsCtor.value
    if (!layer || !G) return null
    if (playheadGfx && playheadGfxHeight === height && !playheadGfx.destroyed) return playheadGfx
    if (playheadGfx && !playheadGfx.destroyed) {
      layer.removeChild(playheadGfx)
      playheadGfx.destroy()
    }
    const gfx = new G()
    gfx.moveTo(0, 0).lineTo(0, height).stroke({ color: COL_PLAYHEAD, width: 2 })
    layer.addChild(gfx)
    playheadGfx = gfx
    playheadGfxHeight = height
    return gfx
  }

  function updatePlayhead(): void {
    if (!scene.isReady.value) return
    const g = computeGeometry()
    if (g.H <= 0) return
    const gfx = ensurePlayheadGfx(g.H)
    if (!gfx) return
    const viewportX = (deps.playheadAbsMs() - g.viewIn) * g.worldPxPerMs - g.scrollPx
    if (viewportX < 0 || viewportX > g.W) {
      gfx.visible = false
      return
    }
    gfx.visible = true
    gfx.x = Math.round(viewportX)
  }

  // --- Shared helpers ---------------------------------------------------------
  function worldX(ms: number, g: SceneGeometry): number {
    return (ms - g.viewIn) * g.worldPxPerMs
  }

  /** Source-ms range covered by the built band (visible window + overscan). */
  function bandMsRange(g: SceneGeometry): { fromMs: number; toMs: number } {
    const overscan = horizontalOverscanPx(g.W)
    const msPerWorldPx = g.worldPxPerMs > 0 ? 1 / g.worldPxPerMs : 0
    const fromPx = Math.max(0, g.scrollPx - overscan)
    const toPx = Math.min(g.worldW, g.scrollPx + g.W + overscan)
    return { fromMs: g.viewIn + fromPx * msPerWorldPx, toMs: g.viewIn + toPx * msPerWorldPx }
  }

  return {
    drawWaveform: () => scheduler.schedule(),
    applyScroll,
    updatePlayhead,
    mountScene,
    unmountScene,
    getCanvas,
    ensureEditorHiResPeaks,
    resetHiResRequestKey
  }
}

function formatRulerTime(ms: number, stepMs: number): string {
  const totalSec = ms / 1000
  if (stepMs < 1000) {
    const decimals = stepMs < 100 ? 2 : 1
    return totalSec.toFixed(decimals) + 's'
  }
  const sign = totalSec < 0 ? '-' : ''
  const t = Math.abs(totalSec)
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${sign}${m}:${s.toString().padStart(2, '0')}`
}
