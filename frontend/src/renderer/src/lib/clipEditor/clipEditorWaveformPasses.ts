// Clip Editor waveform draw passes: ruler chrome/ticks, batched waveform mesh,
// beat grid, selection handles, and the volume-shape overlay. Each pass paints
// onto a supplied Pixi layer using pooled graphics/text from the composable.

import type { Container, Graphics, Text } from 'pixi.js'
import { pickPeaksLod } from '@/lib/peaksLod'
import { envelopeGainAtMs } from '@/lib/envelope'
import { overlayGainToY, volumeOverlayLanes, volumeTimeToSourceMs } from '@/lib/clipEditor/volumeOverlay'
import { horizontalOverscanPx } from '@/lib/timeline/timelineWindow'
import {
  createWaveformRunMerger,
  waveformColumnDown,
  waveformColumnUp
} from '@/lib/timeline/waveformColumn'
import type { createWaveMeshBuilder } from '@/lib/clipEditor/clipEditorWaveMesh'
import type { LibraryItem } from '@/stores/libraryStore'
import type { ClipEditorWaveformDeps, SceneGeometry } from './clipEditorWaveformTypes'
import {
  EDITOR_MIN_STEREO_LANE_PX,
  RULER_H,
  bandMsRange,
  formatRulerTime,
  worldX
} from './clipEditorWaveformGeometry'
import {
  COL_BASELINE,
  COL_BEAT,
  COL_RULER_BG,
  COL_RULER_BORDER,
  COL_RULER_TICK,
  COL_SELECTION,
  COL_SLICE,
  COL_SLICE_HANDLE,
  COL_VOL_DOT_STROKE,
  COL_VOL_ENDPOINT,
  COL_VOL_LINE,
  COL_VOL_MIDPOINT,
  COL_VOL_MIDPOINT_DIM,
  COL_VOL_UNITY,
  COL_WAVE
} from './clipEditorWaveformTheme'

export interface ClipEditorWaveformPassCtx {
  deps: ClipEditorWaveformDeps
  /** A cleared, reusable Graphics from the composable's pool (or null if not ready). */
  acquireGraphics: () => Graphics | null
  /** A reusable Text from the composable's pool with its content set. */
  acquireText: (text: string) => Text | null
  meshBuilder: ReturnType<typeof createWaveMeshBuilder>
}

export function createClipEditorWaveformPasses(ctx: ClipEditorWaveformPassCtx) {
  const { deps, acquireGraphics, acquireText, meshBuilder } = ctx

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
      src.kind === 'clip' ? src.derivedFrom?.sourceItemId : src.id
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

  // --- Loop-slice markers (world layer) ---------------------------------------
  // Vertical lines at each source-ms slice point, with a small top grab handle,
  // drawn only while Slice mode is active. Mirrors the beat-grid line pass but
  // reads the draft marker list rather than a uniform grid.
  function drawSliceMarkers(layer: Container, g: SceneGeometry): void {
    if (!deps.sliceEditActive()) return
    const markers = deps.sliceMarkers()
    if (markers.length === 0) return
    const { fromMs, toMs } = bandMsRange(g)

    const lines = acquireGraphics()
    if (!lines) return
    const handleH = 7
    const handleW = 5
    for (const m of markers) {
      if (m < fromMs - 1 || m > toMs + 1) continue
      const x = Math.round(worldX(m, g)) + 0.5
      lines.moveTo(x, g.waveTop).lineTo(x, g.H)
    }
    lines.stroke({ color: COL_SLICE, width: 1, alpha: 0.9 })

    const handles = acquireGraphics()
    if (!handles) return
    for (const m of markers) {
      if (m < fromMs - 1 || m > toMs + 1) continue
      const x = Math.round(worldX(m, g))
      handles.poly([x - handleW, g.waveTop, x + handleW, g.waveTop, x, g.waveTop + handleH])
    }
    handles.fill(COL_SLICE_HANDLE)
    layer.addChild(lines)
    layer.addChild(handles)
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

  return {
    drawRulerBackground,
    drawRulerTicks,
    drawWaveform,
    drawBeatGrid,
    drawSelection,
    drawSliceMarkers,
    drawVolumeOverlay
  }
}
