// Clip rendering for timeline blocks, waveforms, beat markers, badges, and transitions.

import { type ShallowRef } from 'vue'
import type { Container, Graphics, Text } from 'pixi.js'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive,
  useProjectStore,
  type Clip,
  TRACK_PALETTE,
  PEAKS_PER_SECOND
} from '@/stores/projectStore'
import {
  useLibraryStore,
  libraryItemDisplayName,
  libraryItemSourceBpm,
  libraryItemIsSample,
  type LibraryItem
} from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { pickPeaksLod } from '@/lib/peaksLod'
import { envelopeGainAtMs } from '@/lib/envelope'
import {
  waveformColumnUp,
  waveformColumnDown,
  visibleColumnRange,
  createWaveformRunMerger
} from './waveformColumn'
import {
  TRANSITION_FILL,
  TRANSITION_FILL_ALPHA,
  TRANSITION_LINE,
  TRANSITION_LINE_ALPHA,
  OVERLAP_HATCH,
  OVERLAP_HATCH_ALPHA,
  OVERLAP_HATCH_SPACING_PX
} from './constants'
import { isWarpPending } from '@/lib/warp'
import type { ClipHitRegion } from './useDragHandlers'
import type { GridGeometry } from './useGridGeometry'

/** Minimum px height per stacked stereo lane. */
const MIN_STEREO_LANE_HEIGHT = 18

export interface ClipRendererContext {
  tracksLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  TextCtor: ShallowRef<typeof Text | null>
  geometry: Pick<GridGeometry, 'pxPerSecond' | 'headerWidth'>
  /** Output sink for visible clip hit rectangles. */
  clipHitRegions: ClipHitRegion[]
}

export function createClipRenderer(ctx: ClipRendererContext) {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const { tracksLayer, GraphicsCtor, TextCtor, clipHitRegions } = ctx
  const { pxPerSecond, headerWidth } = ctx.geometry

  // Per-frame Graphics pool. `redraw()` detaches every child via the layer's
  // `removeChildren()` (which does NOT destroy them), so allocating a fresh
  // `Graphics` per clip block/lane/wave/badge on each redraw churned GC on
  // redraw-heavy timelines. Reusing instances across frames removes that churn.
  type PooledGraphics = InstanceType<NonNullable<typeof GraphicsCtor.value>>
  const graphicsPool: PooledGraphics[] = []
  let poolCursor = 0
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
      // app already disposed them) so this frame allocates fresh instances.
      graphicsPool.length = 0
      pooledLayer = layer
    }
    poolCursor = 0
    frameColumns = 0
    frameLanes = 0
    frameRects = 0
  }

  /** Waveform draw counts for the frame just rendered (read after `drawClip`s). */
  function getFrameStats(): { columns: number; lanes: number; graphics: number; rects: number } {
    return { columns: frameColumns, lanes: frameLanes, graphics: poolCursor, rects: frameRects }
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

    const padding = 4
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
    const isSelected = project.selectedClipId === clip.id
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
    // Saved clips usually borrow the source audio-file LOD pyramid.
    let sourceLodOwner = libItem
    if (libItem?.kind === 'saved-clip' && (!baseLibLod || baseLibLod.length <= 1)) {
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
      libItem?.kind === 'saved-clip'
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

    // Draw one lane from the clip's source-time peak window across its pixel width.
    const drawLane = (
      target: InstanceType<NonNullable<typeof GraphicsCtor.value>>,
      lanePeaks: Float32Array,
      lanePps: number,
      laneMidY: number,
      laneHalf: number,
      columnGain?: (px: number) => number
    ): boolean => {
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
      // envelope, the same gain), collapsing to a single rect — pixel-identical
      // output, far fewer rects to tessellate per rebuild.
      const merger = createWaveformRunMerger((sx, ex, yt, yb) => {
        target.rect(absX + sx, yt, ex - sx, yb - yt)
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
        const laneGfx = acquireGraphics(G)
        const drew = drawLane(
          laneGfx,
          lanePeaks,
          lanePps,
          innerY + laneH * ch + laneH / 2,
          fullHalf * gain,
          volumeColumnGain
        )
        if (drew) {
          laneGfx.fill({ color: waveColour, alpha: 0.95 * (0.25 + 0.75 * gain) })
          tracksL.addChild(laneGfx)
        }
      }
    } else {
      const wave = acquireGraphics(G)
      if (drawLane(wave, peaks, peaksPerSecond, midY, innerH / 2 - 2, volumeColumnGain)) {
        wave.fill({ color: waveColour, alpha: 0.95 })
        tracksL.addChild(wave)
      }
    }

    // Source-global synthetic beat grid keeps split clips phase-aligned.
    const beats = libItem?.beats
    const markerSourceBpm = libItem ? libraryItemSourceBpm(libItem, library.byId) : undefined
    // Samples suppress synthetic beat markers even if analysis found beats.
    const treatAsSample = libItem ? libraryItemIsSample(libItem, library.byId) : false
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
      const markers = acquireGraphics(G)
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
        if (x < worldLeft) continue
        if (x > worldRight) break
        markers.moveTo(x + 0.5, innerY + 1).lineTo(x + 0.5, innerY + innerH - 1)
        ++drew
        if (stepMs <= 0) break
      }
      if (drew > 0) {
        markers.stroke({ color: 0xffffff, width: 1, alpha: 0.4 })
        tracksL.addChild(markers)
      }
    }

    drawClipHeader(clip, absX, innerY, w, palette, libItem, markerSourceBpm)
  }

  /** Diagonal hatch over any region where two clips on a track overlap. */
  function drawClipOverlaps(
    track: (typeof project.tracks)[number],
    rowWorldY: number,
    rowHeight: number,
    worldLeft: number,
    worldRight: number
  ): void {
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracksL || !G) return

    const padding = 4
    const innerY = rowWorldY + padding
    const innerH = rowHeight - padding * 2
    if (innerH <= 0) return

    // Sort by timeline start so tail/head overlaps fall between neighbours.
    const ordered = track.clipIds
      .map((id) => project.clips[id])
      .filter((c): c is Clip => Boolean(c))
      .sort((a, b) => a.startMs - b.startMs)

    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = ordered[i]!
      const b = ordered[i + 1]!
      const overlapStartMs = Math.max(a.startMs, b.startMs)
      const overlapEndMs = Math.min(
        a.startMs + effectiveClipDurationMs(a),
        b.startMs + effectiveClipDurationMs(b)
      )
      if (overlapEndMs - overlapStartMs <= 0) continue

      const x0 = headerWidth() + (overlapStartMs / 1000) * pxPerSecond.value
      const x1 = headerWidth() + (overlapEndMs / 1000) * pxPerSecond.value
      if (x1 - x0 < 1) continue // ignore sub-pixel (e.g. butt-joined) overlaps
      if (x1 < worldLeft || x0 > worldRight) continue

      const yTop = innerY
      const yBot = innerY + innerH
      const hatch = acquireGraphics(G)
      // 45° lines clipped to the overlap rect: bottom-left → top-right.
      for (let sx = x0 - innerH; sx < x1; sx += OVERLAP_HATCH_SPACING_PX) {
        const ax = Math.max(sx, x0)
        const bx = Math.min(sx + innerH, x1)
        if (ax >= bx) continue
        hatch.moveTo(ax, yBot - (ax - sx)).lineTo(bx, yBot - (bx - sx))
      }
      // Crisp verticals delimit the shared extent.
      hatch
        .moveTo(x0, yTop)
        .lineTo(x0, yBot)
        .moveTo(x1, yTop)
        .lineTo(x1, yBot)
      hatch.stroke({ color: OVERLAP_HATCH, width: 1, alpha: OVERLAP_HATCH_ALPHA })
      tracksL.addChild(hatch)
    }
  }

  /** Draw transition overlaps from live clip geometry; the fade shape encodes the recipe. */
  function drawTrackTransitions(
    track: (typeof project.tracks)[number],
    rowWorldY: number,
    rowHeight: number,
    worldLeft: number,
    worldRight: number
  ): void {
    const transitions = track.transitions
    if (!transitions || transitions.length === 0) return
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    if (!tracksL || !G) return

    const padding = 4
    const innerY = rowWorldY + padding
    const innerH = rowHeight - padding * 2
    if (innerH <= 0) return

    for (const transition of transitions) {
      const left = project.clips[transition.leftClipId]
      const right = project.clips[transition.rightClipId]
      if (!left || !right) continue

      // Overlap uses warp-scaled timeline footprints, not raw source duration.
      const overlapStartMs = right.startMs
      const overlapEndMs = left.startMs + effectiveClipDurationMs(left)
      if (overlapEndMs - overlapStartMs <= 0) continue

      const x0 = headerWidth() + (overlapStartMs / 1000) * pxPerSecond.value
      const x1 = headerWidth() + (overlapEndMs / 1000) * pxPerSecond.value
      const w = x1 - x0
      if (w <= 0) continue
      if (x1 < worldLeft || x0 > worldRight) continue

      const overlay = acquireGraphics(G)
      overlay
        .roundRect(x0, innerY, w, innerH, 3)
        .fill({ color: TRANSITION_FILL, alpha: TRANSITION_FILL_ALPHA })

      // The two fade legs are drawn so the recipe is readable at a glance:
      // `linear` ("Fade out / in") is a straight X, while `smooth` (equal-power)
      // bows each leg outward along its sin/cos law. yAt maps a gain (0 bottom,
      // 1 top) to a pixel row inside the overlap.
      const yAt = (gain: number): number => innerY + innerH * (1 - gain)
      const isLinear = transition.recipe?.kind === 'linear'
      if (isLinear) {
        overlay
          .moveTo(x0, yAt(0))
          .lineTo(x1, yAt(1)) // fade-in: rises bottom-left → top-right
          .moveTo(x0, yAt(1))
          .lineTo(x1, yAt(0)) // fade-out: falls top-left → bottom-right
      } else {
        const STEPS = 24
        overlay.moveTo(x0, yAt(0))
        for (let i = 1; i <= STEPS; i++) {
          const t = i / STEPS
          overlay.lineTo(x0 + w * t, yAt(Math.sin((t * Math.PI) / 2)))
        }
        overlay.moveTo(x0, yAt(1))
        for (let i = 1; i <= STEPS; i++) {
          const t = i / STEPS
          overlay.lineTo(x0 + w * t, yAt(Math.cos((t * Math.PI) / 2)))
        }
      }
      overlay.stroke({ color: TRANSITION_LINE, width: 1.5, alpha: TRANSITION_LINE_ALPHA })
      tracksL.addChild(overlay)
    }
  }

  function drawClipHeader(
    clip: Clip,
    clipX: number,
    clipInnerY: number,
    clipW: number,
    palette: (typeof TRACK_PALETTE)[number],
    libItem: LibraryItem | undefined,
    headerSourceBpm: number | undefined
  ): void {
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    const T = TextCtor.value
    if (!tracksL || !G || !T) return

    const HEADER_H = 18
    const PAD_X = 4
    const FONT_SIZE = 11
    const APPROX_CHAR_W = 6
    const LINK_BADGE_FULL_W = 18
    const LOCK_BADGE_FULL_W = 14
    const WARP_BADGE_FULL_W = 40
    const STATUS_BADGE_H = 14
    const STATUS_BADGE_R = 5
    const BADGE_GAP = 4
    const NAME_BADGE_GAP = 6
    const PITCH_BADGE_FULL_W = 18

    if (clipW < 20) return

    // Reuse per-clip library/source-BPM resolution from `drawClip`.
    const isLinked = libItem?.kind === 'saved-clip'
    const isLocked = clip.locked === true
    const warpIsPending = isWarpPending({
      warpEnabled: clip.warpEnabled,
      tempoRatio: clip.tempoRatio,
      pendingAutoWarp: clip.pendingAutoWarp,
      sourceBpm: headerSourceBpm,
      projectBpm: transport.bpm
    })
    const warpIsActive = !warpIsPending && isClipTempoWarpActive(clip)

    // Prefer custom name, then library display name, then filename.
    const displayName = clip.name?.trim()
      ? clip.name
      : libItem ? libraryItemDisplayName(libItem) : clip.fileName

    // Measure text after reserving badge space; proportional glyphs vary widely.
    const LINK_BADGE_W = isLinked ? LINK_BADGE_FULL_W : 0
    const LOCK_BADGE_W = isLocked ? LOCK_BADGE_FULL_W : 0
    const WARP_BADGE_W = warpIsPending || warpIsActive ? WARP_BADGE_FULL_W : 0
    const pitchShifted = (clip.semitones ?? 0) !== 0 || (clip.cents ?? 0) !== 0
    const PITCH_BADGE_W = pitchShifted ? PITCH_BADGE_FULL_W : 0
    const BADGE_COUNT =
      (isLinked ? 1 : 0) +
      (isLocked ? 1 : 0) +
      (pitchShifted ? 1 : 0) +
      (warpIsPending || warpIsActive ? 1 : 0)
    const BADGES_W =
      BADGE_COUNT === 0
        ? 0
        : NAME_BADGE_GAP +
          LINK_BADGE_W +
          LOCK_BADGE_W +
          PITCH_BADGE_W +
          WARP_BADGE_W +
          Math.max(0, BADGE_COUNT - 1) * BADGE_GAP
    const maxTextW = Math.max(0, clipW - PAD_X * 2 - BADGES_W)
    const label = new T({
      text: displayName,
      style: {
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: FONT_SIZE,
        fontWeight: '700',
        fill: 0xffffff,
        stroke: { color: 0x09090b, width: 2 }
      }
    })
    if (label.width > maxTextW) {
      if (maxTextW <= APPROX_CHAR_W) {
        label.text = ''
      } else {
        let lo = 0
        let hi = displayName.length
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2)
          label.text = displayName.slice(0, mid) + '…'
          if (label.width <= maxTextW) lo = mid
          else hi = mid - 1
        }
        label.text = lo > 0 ? displayName.slice(0, lo) + '…' : ''
      }
    }

    const labelW = label.text.length > 0 ? label.width : 0
    const desiredW = Math.min(clipW, Math.ceil(labelW) + PAD_X * 2 + BADGES_W)
    const headerBg = acquireGraphics(G)
    headerBg
      .rect(clipX, clipInnerY, desiredW, HEADER_H)
      .fill({ color: palette.border, alpha: 0.95 })
    tracksL.addChild(headerBg)

    label.x = Math.round(clipX + PAD_X)
    label.y = Math.round(clipInnerY + (HEADER_H - FONT_SIZE) / 2 - 1)
    if (label.text.length > 0) tracksL.addChild(label)

    let badgeRight = clipX + desiredW - PAD_X
    if (isLinked) {
      const badge = acquireGraphics(G)
      const cx = badgeRight - LINK_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      badge
        .roundRect(
          cx - LINK_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          LINK_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x09090b, alpha: 0.85 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      badge
        .circle(cx - 2.5, cy, 2.3)
        .stroke({ color: 0xffffff, width: 1.5 })
        .circle(cx + 2.5, cy, 2.3)
        .stroke({ color: 0xffffff, width: 1.5 })
      tracksL.addChild(badge)
      badgeRight -= LINK_BADGE_FULL_W + BADGE_GAP
    }
    if (isLocked) {
      // Compact padlock glyph sized to match other badges.
      const cx = badgeRight - LOCK_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      const bg = acquireGraphics(G)
      bg
        .roundRect(
          cx - LOCK_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          LOCK_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x18181b, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const glyph = acquireGraphics(G)
      const bodyW = 6
      const bodyH = 5
      const bodyX = cx - bodyW / 2
      const bodyY = cy - 1
      glyph.roundRect(bodyX, bodyY, bodyW, bodyH, 1).fill({ color: 0xffffff })
      tracksL.addChild(glyph)
      // Separate shackle path avoids Pixi stroking from the previous origin.
      const shackle = acquireGraphics(G)
      const shackleR = 2.2
      const shackleCy = bodyY
      shackle.moveTo(cx - shackleR, shackleCy)
      shackle
        .arc(cx, shackleCy, shackleR, Math.PI, 0)
        .stroke({ color: 0xffffff, width: 1.2 })
      tracksL.addChild(shackle)
      badgeRight -= LOCK_BADGE_FULL_W + BADGE_GAP
    }
    if (pitchShifted) {
      const bg = acquireGraphics(G)
      const cx = badgeRight - PITCH_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      bg
        .roundRect(
          cx - PITCH_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          PITCH_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x18181b, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const badge = new T({
        text: '♪',
        style: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 11,
          fontWeight: '700',
          fill: 0xffffff
        }
      })
      badge.x = Math.round(cx - 4)
      badge.y = Math.round(cy - 8)
      tracksL.addChild(badge)
      badgeRight -= PITCH_BADGE_FULL_W + BADGE_GAP
    }
    if (warpIsPending) {
      const badge = acquireGraphics(G)
      const cx = badgeRight - WARP_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      const phase = Math.floor(Date.now() / 125) % 8
      const radius = 4.2
      badge
        .roundRect(
          cx - WARP_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          WARP_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x0f172a, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      for (let i = 0; i < 8; i++) {
        const angle = ((i - phase) / 8) * Math.PI * 2
        const alpha = 0.25 + ((i + 1) / 8) * 0.65
        badge
          .circle(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 1.1)
          .fill({ color: 0xffffff, alpha })
      }
      tracksL.addChild(badge)
    } else if (warpIsActive) {
      const bg = acquireGraphics(G)
      const cx = badgeRight - WARP_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      bg
        .roundRect(
          cx - WARP_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          WARP_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x0f172a, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const badge = new T({
        text: 'WARP',
        style: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 9,
          fontWeight: '700',
          fill: 0xfacc15
        }
      })
      badge.x = Math.round(cx - 14)
      badge.y = Math.round(cy - 7)
      tracksL.addChild(badge)
    }
  }

  return { drawClip, drawClipOverlaps, drawTrackTransitions, beginFrame, getFrameStats }
}
