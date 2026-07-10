// Clip rendering for timeline blocks, waveforms, beat markers, badges, and transitions.

import { type ShallowRef } from 'vue'
import type { Container, Graphics, Mesh, MeshGeometry, Text, Texture } from 'pixi.js'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive,
  useProjectStore,
  type Clip,
  TRACK_PALETTE,
  PEAKS_PER_SECOND
} from '@/stores/projectStore'
import { useLibraryStore, libraryItemSourceBpm, libraryItemIsSimple } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { pickPeaksLod } from '@/lib/peaksLod'
import { envelopeGainAtMs } from '@/lib/envelope'
import { updateWaveMeshGeometry } from '@/lib/wave-mesh-geometry'
import {
  waveformColumnUp,
  waveformColumnDown,
  visibleColumnRange,
  createWaveformRunMerger
} from './waveformColumn'
import { CLIP_VERTICAL_PADDING } from './constants'
import { createClipHeaderRenderer } from './clipHeaderRenderer'
import { createClipDecorationsRenderer } from './clipDecorationsRenderer'
import type { ClipHitRegion } from './useDragHandlers'
import type { GridGeometry } from './useGridGeometry'

/** Minimum px height per stacked stereo lane. */
const MIN_STEREO_LANE_HEIGHT = 18

export interface ClipRendererContext {
  tracksLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  TextCtor: ShallowRef<typeof Text | null>
  MeshCtor: ShallowRef<typeof Mesh | null>
  MeshGeometryCtor: ShallowRef<typeof MeshGeometry | null>
  whiteTexture: ShallowRef<Texture | null>
  geometry: Pick<GridGeometry, 'pxPerSecond' | 'headerWidth'>
  /** Output sink for visible clip hit rectangles. */
  clipHitRegions: ClipHitRegion[]
}

export function createClipRenderer(ctx: ClipRendererContext) {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const { tracksLayer, GraphicsCtor, TextCtor, MeshCtor, MeshGeometryCtor, whiteTexture, clipHitRegions } =
    ctx
  const { pxPerSecond, headerWidth } = ctx.geometry

  // Per-frame Graphics pool. `redraw()` detaches every child via the layer's
  // `removeChildren()` (which does NOT destroy them), so allocating a fresh
  // `Graphics` per clip block/lane/wave/badge on each redraw churned GC on
  // redraw-heavy timelines. Reusing instances across frames removes that churn.
  type PooledGraphics = InstanceType<NonNullable<typeof GraphicsCtor.value>>
  const graphicsPool: PooledGraphics[] = []
  let poolCursor = 0
  // Dedicated pool for clip beat-marker overlays. Markers are the only
  // CONDITIONALLY-drawn clip element, so they must NOT share `graphicsPool`:
  // there, a clip that gains/loses markers between frames shifts every later
  // clip's pool slot, so a Graphics that held a header last frame gets reused as
  // markers this frame. Reusing a detached-and-re-added pooled Graphics that way
  // leaves Pixi's batcher in a stale state and the geometry silently never
  // paints (the same class of failure the waveform Mesh works around with
  // `no-batch`). A separate pool keyed by its own cursor gives each
  // marker-drawing clip a STABLE instance across frames — reused (no per-frame
  // `new Graphics()` leak) and never repurposed (no batcher corruption).
  const markerGraphicsPool: PooledGraphics[] = []
  let markerCursor = 0
  // Identity of the tracks layer the pool was built against. A GPU reset (TDR)
  // loses the WebGL context, so `usePixiApp` tears the Pixi app down and rebuilds
  // it with brand-new layers; the previous frame's pooled Graphics were children
  // of the destroyed app and are destroyed with it. Reusing those dead instances
  // paints nothing (missing waveforms) and churns garbage frames (flicker). Track
  // the layer so we can drop the stale pool when the app is rebuilt.
  let pooledLayer: Container | null = null

  // Per-frame draw counters for performance instrumentation. `columnsEmitted` is
  // the key metric: today it scales with full clip width (project length × zoom),
  // not the viewport, which is the dominant redraw cost.
  let frameColumns = 0
  let frameLanes = 0
  // Rects actually emitted after run-length merging equal-height adjacent
  // columns. At high zoom (many px per peak) this is far below frameColumns,
  // which is where the per-rebuild geometry cost is saved.
  let frameRects = 0

  // Reset the pool cursor at the start of each redraw — call AFTER the caller has
  // detached the previous frame's children. Acquired instances are re-added in
  // draw order, so child z-ordering is identical to fresh allocation.
  function beginFrame(): void {
    const layer = tracksLayer.value
    if (layer !== pooledLayer) {
      // App was rebuilt: forget the destroyed Graphics (no destroy() — the old
      // app already disposed them) so this frame allocates fresh instances. The
      // waveform Mesh pool is tied to the same layer, so drop it in lock-step.
      graphicsPool.length = 0
      meshPool.length = 0
      markerGraphicsPool.length = 0
      pooledLayer = layer
    }
    poolCursor = 0
    meshCursor = 0
    markerCursor = 0
    frameColumns = 0
    frameLanes = 0
    frameRects = 0
  }

  /** Waveform draw counts for the frame just rendered (read after `drawClip`s). */
  function getFrameStats(): {
    columns: number
    lanes: number
    graphics: number
    rects: number
    meshes: number
  } {
    return {
      columns: frameColumns,
      lanes: frameLanes,
      graphics: poolCursor,
      rects: frameRects,
      meshes: meshCursor
    }
  }

  // Hand back a cleared, reusable Graphics. Grows the pool to the peak number of
  // graphics drawn in a single frame (bounded by visible clips); the surplus is
  // released when the Pixi app is destroyed on unmount. Only drawing commands are
  // reset by `clear()`; these graphics never set display props (alpha/tint/etc.),
  // so no further reset is required.
  function acquireGraphics(G: NonNullable<typeof GraphicsCtor.value>): PooledGraphics {
    const existing = graphicsPool[poolCursor]
    if (existing) {
      existing.clear()
      poolCursor++
      return existing
    }
    const created = new G()
    graphicsPool[poolCursor] = created
    poolCursor++
    return created
  }

  // Beat-marker allocator: same reuse contract as `acquireGraphics`, but from the
  // dedicated `markerGraphicsPool` so a marker's pooled instance is stable across
  // frames regardless of which clips do or don't draw markers this frame.
  function acquireMarkerGraphics(G: NonNullable<typeof GraphicsCtor.value>): PooledGraphics {
    const existing = markerGraphicsPool[markerCursor]
    if (existing) {
      existing.clear()
      markerCursor++
      return existing
    }
    const created = new G()
    markerGraphicsPool[markerCursor] = created
    markerCursor++
    return created
  }

  // Non-hot decoration/header passes share the pooled Graphics allocator but live
  // in focused sibling modules; only the real-time waveform path stays inline.
  const { drawClipHeader } = createClipHeaderRenderer({
    tracksLayer,
    GraphicsCtor,
    TextCtor,
    transport,
    acquireGraphics
  })
  const { drawClipOverlaps, drawTrackTransitions, drawClipBrakes, drawClipBackspins } = createClipDecorationsRenderer({
    tracksLayer,
    GraphicsCtor,
    geometry: ctx.geometry,
    project,
    acquireGraphics
  })

  // Batched waveform geometry. Emitting ~20k `Graphics.rect()` commands per lane
  // allocated an instruction object per rect and re-tessellated the whole context
  // every rebuild — the source of the periodic GC/upload spikes. Instead, each
  // lane's bars are packed into ONE Mesh: a single position/index buffer (two
  // triangles per merged rect, no earcut) uploaded once. The Mesh tints a shared
  // 1×1 white texture to the wave colour.
  type PooledMesh = InstanceType<NonNullable<typeof MeshCtor.value>>
  const meshPool: PooledMesh[] = []
  let meshCursor = 0

  // Scratch geometry buffers, grown to the busiest lane and reused every frame.
  let waveXY = new Float32Array(8192) // 2 floats per vertex
  let waveIdx = new Uint32Array(12288) // 6 indices per quad
  let waveVerts = 0 // vertices written so far this lane
  let waveIndices = 0

  function resetWaveBuilder(): void {
    waveVerts = 0
    waveIndices = 0
  }

  function pushWaveQuad(x0: number, y0: number, x1: number, y1: number): void {
    const needFloats = (waveVerts + 4) * 2
    if (needFloats > waveXY.length) {
      let len = waveXY.length
      while (len < needFloats) len *= 2
      const grown = new Float32Array(len)
      grown.set(waveXY)
      waveXY = grown
    }
    if (waveIndices + 6 > waveIdx.length) {
      let len = waveIdx.length
      while (len < waveIndices + 6) len *= 2
      const grown = new Uint32Array(len)
      grown.set(waveIdx)
      waveIdx = grown
    }
    const base = waveVerts
    let p = waveVerts * 2
    waveXY[p++] = x0
    waveXY[p++] = y0
    waveXY[p++] = x1
    waveXY[p++] = y0
    waveXY[p++] = x1
    waveXY[p++] = y1
    waveXY[p++] = x0
    waveXY[p++] = y1
    waveVerts += 4
    let q = waveIndices
    waveIdx[q++] = base
    waveIdx[q++] = base + 1
    waveIdx[q++] = base + 2
    waveIdx[q++] = base
    waveIdx[q++] = base + 2
    waveIdx[q++] = base + 3
    waveIndices = q
  }

  // Upload the current builder contents as a pooled, tinted Mesh on the tracks
  // layer. Returns false when there's nothing to draw or Pixi isn't ready.
  function flushWaveMesh(tint: number, alpha: number): boolean {
    const layer = tracksLayer.value
    const M = MeshCtor.value
    const MG = MeshGeometryCtor.value
    const tex = whiteTexture.value
    if (!layer || !M || !MG || !tex || waveIndices === 0) return false
    // Exact-length copies: each geometry buffer keeps its own backing array (the
    // scratch builders are reused by the next lane/frame). UVs are all zero, so
    // every vertex samples the 1×1 white pixel and is tinted to the wave colour.
    const positions = waveXY.slice(0, waveVerts * 2)
    const indices = waveIdx.slice(0, waveIndices)
    const existing = meshPool[meshCursor]
    if (existing) {
      // Reuse BOTH the Mesh shell AND its geometry, updating the buffers in
      // place rather than allocating a fresh MeshGeometry and destroying the old
      // one every flush. This removes per-frame geometry/GPU-buffer churn and the
      // VRAM leak the default Geometry.destroy() left behind (it never frees the
      // position/uv buffers). Pixi's Buffer `data` setter handles both in-place
      // re-upload and resize, so no geometry lifecycle teardown occurs per frame.
      const geo = existing.geometry as MeshGeometry
      updateWaveMeshGeometry(geo, positions, indices)
      existing.tint = tint
      existing.alpha = alpha
      layer.addChild(existing)
    } else {
      // `no-batch`: keep these waveform meshes off Pixi's batcher entirely. Small
      // meshes (≤100 verts) default to `batchMode:'auto'` → batched, but the
      // batcher path crashes here: when a pooled shell is detached
      // (`removeChildren` each redraw) and re-added, its cached BatchableMesh can
      // be left with a null `_batcher`, so the next `MeshPipe.updateRenderable`
      // throws `Cannot read properties of null (reading 'updateElement')` INSIDE
      // Pixi's render loop — aborting the frame and leaving every waveform black
      // permanently. We already pack each lane into a single mesh, so batching
      // buys nothing; the direct (non-batched) path renders our Uint32 geometry
      // robustly.
      const geometry = new MG({ positions, indices })
      geometry.batchMode = 'no-batch'
      const mesh = new M({ geometry, texture: tex })
      mesh.tint = tint
      mesh.alpha = alpha
      meshPool[meshCursor] = mesh
      layer.addChild(mesh)
    }
    meshCursor++
    return true
  }

  function drawClip(
    clip: Clip,
    rowWorldY: number,
    rowHeight: number,
    palette: (typeof TRACK_PALETTE)[number],
    worldLeft: number,
    worldRight: number,
    trackPan: number
  ): void {
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracksL || !G) return

    const absX = headerWidth() + (clip.startMs / 1000) * pxPerSecond.value
    const libItem = clip.libraryItemId
      ? library.byId[clip.libraryItemId]
      : library.items.find((i) => i.filePath === clip.filePath)
    const effectiveDurMs = effectiveClipDurationMs(clip)
    const w = (effectiveDurMs / 1000) * pxPerSecond.value
    const warpRatio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1

    // Cull beyond one viewport margin so translate-only scroll stays smooth.
    if (absX + w < worldLeft || absX > worldRight) return

    const padding = CLIP_VERTICAL_PADDING
    const innerY = rowWorldY + padding
    const innerH = rowHeight - padding * 2
    const midY = innerY + innerH / 2

    // Unresolved clips render muted with a red warning border.
    const fillColour = clip.unresolved ? 0x3f3f46 : palette.fill // zinc-700 vs palette
    const borderColour = clip.unresolved ? 0xef4444 : palette.border // red-500 vs palette
    const waveColour = clip.unresolved ? 0x71717a : palette.wave // zinc-500 vs palette
    const fillAlpha = clip.unresolved ? 0.5 : 0.85
    const borderAlpha = clip.unresolved ? 0.85 : 0.9

    // Selected clips use a thicker palette border without masking unresolved red.
    const isSelected = project.isClipSelected(clip.id)
    const borderWidth = isSelected ? 3 : 1
    const effectiveBorderAlpha = isSelected ? 1.0 : borderAlpha

    const block = acquireGraphics(G)
    block
      .roundRect(absX, innerY, w, innerH, 4)
      .fill({ color: fillColour, alpha: fillAlpha })
      .stroke({ color: borderColour, width: borderWidth, alpha: effectiveBorderAlpha })
    tracksL.addChild(block)

    // Hit regions are stored in world coordinates.
    clipHitRegions.push({ clipId: clip.id, x: absX, y: innerY, w, h: innerH })

    // Map each pixel column to its source peak window for zoom-stable timing.
    const baseLibPeaks = libItem?.peaks
    const baseLibPps = libItem?.peaksPerSecond
    const baseLibLod = libItem?.peaksLod
    // Saved clips usually borrow the source file's LOD pyramid.
    let sourceLodOwner = libItem
    if (libItem?.kind === 'clip' && (!baseLibLod || baseLibLod.length <= 1)) {
      const sourceId = libItem.derivedFrom?.sourceItemId
      if (sourceId) {
        const source = library.byId[sourceId]
        if (source) sourceLodOwner = source
      }
    }
    // Pick an LOD so each pixel column covers roughly 1-2 peaks.
    let peaks: Float32Array = clip.peaks
    let peaksPerSecond = clip.peaksPerSecond ?? baseLibPps ?? PEAKS_PER_SECOND
    const lod = sourceLodOwner?.peaksLod ?? (baseLibLod ?? undefined)
    if (lod && lod.length > 0 && pxPerSecond.value > 0) {
      // Warped clips need LOD selection in source-time pixels, not timeline pixels.
      const drawPxPerSrcSec = pxPerSecond.value / warpRatio
      const picked = pickPeaksLod(lod, drawPxPerSrcSec, peaksPerSecond)
      if (picked.peaks.length >= 4 && picked.peaksPerSecond > 0) {
        peaks = picked.peaks
        peaksPerSecond = picked.peaksPerSecond
      }
    } else if (baseLibPeaks && baseLibPeaks.length >= 4 && clip.peaks.length === 0) {
      // Fall back to source raw peaks until clip peaks land.
      peaks = baseLibPeaks
      peaksPerSecond = baseLibPps ?? PEAKS_PER_SECOND
    }
    // Stereo mode needs per-channel peaks and enough height for two lanes.
    const channelSourceItem =
      libItem?.kind === 'clip'
        ? libItem.derivedFrom?.sourceItemId
          ? library.byId[libItem.derivedFrom.sourceItemId]
          : undefined
        : libItem
    const channelEntry = channelSourceItem
      ? library.channelPeaksByItemId[channelSourceItem.id]
      : undefined
    const wantStereo =
      ui.waveformDisplayMode === 'stereo' &&
      !!channelEntry &&
      channelEntry.channels.length === 2 &&
      innerH >= MIN_STEREO_LANE_HEIGHT * 2

    // Build one lane's bars into the shared Mesh vertex buffer. Returns true when
    // at least one column produced geometry; the caller then uploads it as a
    // tinted Mesh via `flushWaveMesh`.
    const drawLane = (
      lanePeaks: Float32Array,
      lanePps: number,
      laneMidY: number,
      laneHalf: number,
      columnGain?: (px: number) => number
    ): boolean => {
      resetWaveBuilder()
      const lanePeakCount = lanePeaks.length / 2
      if (lanePeakCount <= 0 || w <= 0) return false
      const startPeak = Math.max(0, Math.floor((clip.inMs / 1000) * lanePps))
      const endPeak = Math.min(
        lanePeakCount,
        Math.max(startPeak + 1, Math.ceil(((clip.inMs + clip.durationMs) / 1000) * lanePps))
      )
      const windowSize = endPeak - startPeak
      const peaksPerPixel = windowSize / w
      const reversed = clip.reversed === true
      let didDraw = false
      let drawnColumns = 0
      let emittedRects = 0
      // Merge consecutive columns with identical top/bottom into one wider rect.
      // At high zoom many adjacent pixels read the same peak (and, with no volume
      // envelope, the same gain), collapsing to a single quad — pixel-identical
      // output, fewer triangles per rebuild.
      const merger = createWaveformRunMerger((sx, ex, yt, yb) => {
        pushWaveQuad(absX + sx, yt, absX + ex, yb)
        ++emittedRects
      })
      // Only emit columns inside the horizontal draw band; columns outside the
      // viewport (+overscan) are never visible, so building them is pure waste.
      const { from: pxFrom, to: pxTo } = visibleColumnRange(absX, w, worldLeft, worldRight)
      for (let px = pxFrom; px < pxTo; px++) {
        // Reversed clips read the source window back-to-front; the volume
        // envelope below stays oriented to clip-time, so only the peak read
        // is mirrored here.
        const srcPx = reversed ? w - 1 - px : px
        const startIdx = startPeak + Math.floor(srcPx * peaksPerPixel)
        // Always read at least one peak per pixel when zoomed in.
        const endIdx = Math.min(
          endPeak,
          Math.max(startIdx + 1, startPeak + Math.ceil((srcPx + 1) * peaksPerPixel))
        )
        if (startIdx >= endPeak) {
          // Out-of-data column: close the current run so it never spans the gap.
          merger.breakRun(px)
          if (reversed) continue
          break
        }

        let min = 0
        let max = 0
        for (let i = startIdx; i < endIdx; i++) {
          const lo = lanePeaks[i * 2]!
          const hi = lanePeaks[i * 2 + 1]!
          if (lo < min) min = lo
          if (hi > max) max = hi
        }

        // Apply per-column envelope gain so waveform height follows clip volume.
        // Scalar excursion helpers avoid allocating a {up,down} object per
        // column (~20k/redraw) — that GC churn was the main per-rebuild jitter.
        const colGain = columnGain ? columnGain(px) : 1
        const yTop = laneMidY - waveformColumnUp(max, laneHalf, colGain)
        const rawBot = laneMidY + waveformColumnDown(min, laneHalf, colGain)
        // Equivalent pixel coverage to a 1px stroked vertical line, with a 1px
        // minimum so silent columns stay visible.
        const yBot = rawBot < yTop + 1 ? yTop + 1 : rawBot
        merger.push(px, yTop, yBot)
        didDraw = true
        ++drawnColumns
      }
      merger.finish(pxTo)
      frameColumns += drawnColumns
      frameRects += emittedRects
      if (drawnColumns > 0) ++frameLanes
      return didDraw
    }

    // Sample envelope at pixel centres to avoid biased steep fades.
    const envPoints = clip.envelopePoints
    const volumeColumnGain =
      envPoints && envPoints.length >= 2 && effectiveDurMs > 0 && w > 0
        ? (px: number): number =>
            envelopeGainAtMs(envPoints, Math.min(effectiveDurMs, ((px + 0.5) / w) * effectiveDurMs))
        : undefined

    if (wantStereo && channelEntry) {
      // Stereo lanes use channel LODs and equal-power pan gains.
      const laneH = innerH / 2
      const fullHalf = laneH / 2 - 2
      const drawPxPerSrcSec = pxPerSecond.value / warpRatio
      const angle = ((Math.max(-1, Math.min(1, Number.isFinite(trackPan) ? trackPan : 0)) + 1) * Math.PI) / 4
      const rawGains = [Math.cos(angle), Math.sin(angle)] as const
      const norm = Math.max(rawGains[0], rawGains[1]) || 1
      const laneGains = [rawGains[0] / norm, rawGains[1] / norm] as const
      for (let ch = 0; ch < 2; ch++) {
        let lanePeaks = channelEntry.channels[ch]!
        let lanePps = channelEntry.peaksPerSecond
        const clod = channelEntry.lod[ch]
        if (clod && clod.length > 0 && pxPerSecond.value > 0) {
          const picked = pickPeaksLod(clod, drawPxPerSrcSec, lanePps)
          if (picked.peaks.length >= 4 && picked.peaksPerSecond > 0) {
            lanePeaks = picked.peaks
            lanePps = picked.peaksPerSecond
          }
        }
        const gain = laneGains[ch]!
        const drew = drawLane(
          lanePeaks,
          lanePps,
          innerY + laneH * ch + laneH / 2,
          fullHalf * gain,
          volumeColumnGain
        )
        if (drew) flushWaveMesh(waveColour, 0.95 * (0.25 + 0.75 * gain))
      }
    } else {
      if (drawLane(peaks, peaksPerSecond, midY, innerH / 2 - 2, volumeColumnGain)) {
        flushWaveMesh(waveColour, 0.95)
      }
    }

    // Source-global synthetic beat grid keeps split clips phase-aligned.
    const beats = libItem?.beats
    const markerSourceBpm = libItem ? libraryItemSourceBpm(libItem, library.byId) : undefined
    // Samples suppress synthetic beat markers even if analysis found beats.
    const treatAsSample = libItem ? libraryItemIsSimple(libItem, library.byId) : false
    // Prefer regression-derived anchor; older projects fall back to `beats[0]`.
    const anchorSec = libItem?.beatAnchorSec ?? beats?.[0]
    if (!treatAsSample && beats && beats.length > 0 && markerSourceBpm && markerSourceBpm > 0 && anchorSec !== undefined && w > 0) {
      const pxPerMs = pxPerSecond.value / 1000
      const inMs = clip.inMs
      const outMs = inMs + clip.durationMs
      const beatSpacingMs = (60 / markerSourceBpm) * 1000
      const universalAnchorMs = anchorSec * 1000
      // First synthetic beat at or after `inMs`.
      let firstBeatMs =
        universalAnchorMs +
        Math.ceil((inMs - universalAnchorMs) / beatSpacingMs) * beatSpacingMs
      while (firstBeatMs < inMs) firstBeatMs += beatSpacingMs
      const minMarkerSpacingPx = 4
      // Dedicated, stable pooled Graphics (see `markerGraphicsPool`): avoids both
      // the shared-pool slot-shift that corrupted Pixi's batcher (markers silently
      // not painting) and the per-frame `new Graphics()` leak.
      const markers = acquireMarkerGraphics(G)
      let drew = 0
      // Stride by whole beats when zoomed out to avoid drawing skipped markers.
      const pxPerBeat = (beatSpacingMs / warpRatio) * pxPerMs
      const beatStride =
        pxPerBeat > 0 ? Math.max(1, Math.ceil(minMarkerSpacingPx / pxPerBeat)) : 1
      const stepMs = beatSpacingMs * beatStride
      for (let beatMs = firstBeatMs; beatMs <= outMs; beatMs += stepMs) {
        const offsetInClipMs = beatMs - inMs
        if (offsetInClipMs < 0) continue
        const x = absX + (offsetInClipMs / warpRatio) * pxPerMs
        // A non-finite x (NaN/Infinity from a bad ratio or anchor) would slip
        // past both bounds checks below (NaN comparisons are always false) and
        // push invalid geometry that Pixi silently drops — draw nothing instead.
        if (!Number.isFinite(x)) continue
        if (x < worldLeft) continue
        if (x > worldRight) break
        // Filled 1px rect rather than a stroked line. Stroke-only pooled Graphics
        // detached/re-added each redraw can leave Pixi's batcher in a state where
        // the geometry silently never paints (observed: markers computed + added
        // to the layer yet invisible). Filled geometry uses the same reliable path
        // as the clip block and waveform mesh, which always render.
        markers.rect(Math.round(x), innerY + 1, 1, Math.max(1, innerH - 2))
        ++drew
        if (stepMs <= 0) break
      }
      if (drew > 0) {
        markers.fill({ color: 0xffffff, alpha: 0.4 })
        tracksL.addChild(markers)
      }
    }

    drawClipHeader(clip, absX, innerY, w, palette, libItem, markerSourceBpm)
  }

  return { drawClip, drawClipOverlaps, drawTrackTransitions, drawClipBrakes, drawClipBackspins, beginFrame, getFrameStats }
}
