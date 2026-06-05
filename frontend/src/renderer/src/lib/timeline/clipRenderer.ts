// Clip rendering for the timeline scene.
//
// Owns every "paint a clip onto the tracks layer" routine: the clip block +
// border, its mono / stereo waveform lanes (volume-envelope reflected), the
// synthesised beat-marker grid, the per-clip header (name text + status
// badges), and the crossfade transition overlays. Extracted from
// `useTimelineDrawing` so the (substantial) clip-drawing code can be reasoned
// about on its own, leaving the host composable to orchestrate the scene
// (ruler, grid, rows, playhead, scroll).
//
// `createClipRenderer` is a composable-style factory: it must be called during
// timeline setup (active Pinia required) and returns the two entry points the
// host's `drawTracks` calls per row. It reads Pixi handles + geometry from the
// passed `ShallowRef`s/getter at draw time so live values are always used; the
// shared `clipHitRegions` array is an output sink owned (and cleared) by the
// host and consumed by `useDragHandlers` for hit-testing.

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
import { waveformColumnExcursion } from './waveformColumn'
import {
  TRANSITION_FILL,
  TRANSITION_FILL_ALPHA,
  TRANSITION_LINE,
  TRANSITION_LINE_ALPHA
} from './constants'
import { isWarpPending } from '@/lib/warp'
import type { ClipHitRegion } from './useDragHandlers'
import type { GridGeometry } from './useGridGeometry'

/** Minimum height (px) each stereo lane needs before the timeline will
 *  split a clip's waveform into stacked left / right lanes. Below twice
 *  this, the clip falls back to the single summary lane so short rows
 *  stay legible. */
const MIN_STEREO_LANE_HEIGHT = 18

export interface ClipRendererContext {
  tracksLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  TextCtor: ShallowRef<typeof Text | null>
  /** Only the horizontal geometry is needed for clip placement. */
  geometry: Pick<GridGeometry, 'pxPerSecond' | 'headerWidth'>
  /** Output sink: `drawClip` pushes one hit rectangle per visible clip.
   *  Owned and cleared by the host; consumed by `useDragHandlers`. */
  clipHitRegions: ClipHitRegion[]
}

export function createClipRenderer(ctx: ClipRendererContext) {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const { tracksLayer, GraphicsCtor, TextCtor, clipHitRegions } = ctx
  const { pxPerSecond, headerWidth } = ctx.geometry

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

    // Generous world-space cull: anything entirely outside the current
    // viewport plus one viewport's worth of margin on each side is
    // skipped. The margin keeps scroll-without-redraw smooth — by the
    // time scroll has moved a viewport width, the next user action
    // (zoom, content change) will trigger a fresh redraw.
    if (absX + w < worldLeft || absX > worldRight) return

    const padding = 4
    const innerY = rowWorldY + padding
    const innerH = rowHeight - padding * 2
    const midY = innerY + innerH / 2

    // Unresolved clips (source file missing on disk) render in muted
    // greys with a dashed red border so they're visibly broken at a
    // glance; clicking through to the toast's Locate-files… affordance
    // is how the user repairs them.
    const fillColour = clip.unresolved ? 0x3f3f46 : palette.fill // zinc-700 vs palette
    const borderColour = clip.unresolved ? 0xef4444 : palette.border // red-500 vs palette
    const waveColour = clip.unresolved ? 0x71717a : palette.wave // zinc-500 vs palette
    const fillAlpha = clip.unresolved ? 0.5 : 0.85
    const borderAlpha = clip.unresolved ? 0.85 : 0.9

    // Selected clips get a noticeably thicker border so the user can
    // see at a glance which clip Cut / Copy would act on. The colour
    // stays the palette border (slightly brighter) so the selection
    // doesn't conflict with the unresolved-red warning.
    const isSelected = project.selectedClipId === clip.id
    const borderWidth = isSelected ? 3 : 1
    const effectiveBorderAlpha = isSelected ? 1.0 : borderAlpha

    // Clip block + border (palette-coloured; muted when unresolved).
    const block = new G()
    block
      .roundRect(absX, innerY, w, innerH, 4)
      .fill({ color: fillColour, alpha: fillAlpha })
      .stroke({ color: borderColour, width: borderWidth, alpha: effectiveBorderAlpha })
    tracksL.addChild(block)

    // Hit region in WORLD coordinates — useDragHandlers converts to
    // viewport space at test time using the current scrollX/Y.
    clipHitRegions.push({ clipId: clip.id, x: absX, y: innerY, w, h: innerH })

    // Waveform — iterate the clip's pixel range once. Map each pixel
    // proportionally onto the peak-index space so the rendering stays
    // time-accurate at both ends of the zoom range:
    //
    //   - Zoomed OUT (peakCount ≥ w):  multiple peaks per pixel → take
    //     the min/max over the covered range (visual decimation).
    //   - Zoomed IN  (peakCount < w):  multiple pixels per peak → each
    //     pixel reads the single peak whose time it falls into, which
    //     produces a horizontally-stretched envelope. The previous
    //     algorithm clamped `samplesPerPixel` to 1, which incorrectly
    //     spaced peaks 1 px apart regardless of width — causing the
    //     waveform to "drift" leftward off its clip block at high
    //     zoom.
    const baseLibPeaks = libItem?.peaks
    const baseLibPps = libItem?.peaksPerSecond
    const baseLibLod = libItem?.peaksLod
    // For saved-clip items, peaks live on the source audio-file item.
    // Look up the LOD pyramid there if the saved clip has no peaks of
    // its own (the common case after the rebind refactor).
    let sourceLodOwner = libItem
    if (libItem?.kind === 'saved-clip' && (!baseLibLod || baseLibLod.length <= 1)) {
      const sourceId = libItem.derivedFrom?.sourceItemId
      if (sourceId) {
        const source = library.byId[sourceId]
        if (source) sourceLodOwner = source
      }
    }
    // Drawing reads from a single peaks array + ppS, picked from the
    // LOD pyramid where available so each pixel column covers ~1–2
    // peaks. Falls back to the clip's own (or library item's) base
    // peaks when no pyramid has been built yet.
    let peaks: Float32Array = clip.peaks
    let peaksPerSecond = clip.peaksPerSecond ?? baseLibPps ?? PEAKS_PER_SECOND
    const lod = sourceLodOwner?.peaksLod ?? (baseLibLod ?? undefined)
    if (lod && lod.length > 0 && pxPerSecond.value > 0) {
      // The clip's draw pixel-per-source-second is `pxPerSecond / warpRatio`
      // — a warped clip's pixel column covers `warpRatio` more source
      // time than an unwarped clip, so we want a finer LOD on warped
      // clips by that factor. `warpRatio = 1` gives the unwarped path.
      const drawPxPerSrcSec = pxPerSecond.value / warpRatio
      const picked = pickPeaksLod(lod, drawPxPerSrcSec, peaksPerSecond)
      if (picked.peaks.length >= 4 && picked.peaksPerSecond > 0) {
        peaks = picked.peaks
        peaksPerSecond = picked.peaksPerSecond
      }
    } else if (baseLibPeaks && baseLibPeaks.length >= 4 && clip.peaks.length === 0) {
      // Saved-clip / placeholder clip falls back to the source audio-file's
      // raw peaks until its own peaks land.
      peaks = baseLibPeaks
      peaksPerSecond = baseLibPps ?? PEAKS_PER_SECOND
    }
    // Stereo display: when the user has opted into the stereo waveform
    // mode AND this clip's source has per-channel peaks AND the clip row
    // is tall enough to fit two readable lanes, draw separate L/R lanes.
    // Otherwise fall back to the single summary lane (the default).
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

    // Draw one waveform lane into `target` from `lanePeaks`, centred on
    // `laneMidY` with a half-height of `laneHalf`. Windows the source
    // peaks by the clip's `[inMs, inMs + durationMs]` range and maps the
    // window across the clip's pixel width (see the zoom notes above).
    // Returns whether any column was drawn so the caller can skip an
    // empty stroke.
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
      let didDraw = false
      for (let px = 0; px < w; px++) {
        const startIdx = startPeak + Math.floor(px * peaksPerPixel)
        // Always read at least one peak per pixel — when zoomed in
        // (peaksPerPixel < 1) consecutive pixels would otherwise share
        // the same `startIdx` AND `endIdx`, producing no draw.
        const endIdx = Math.min(
          endPeak,
          Math.max(startIdx + 1, startPeak + Math.ceil((px + 1) * peaksPerPixel))
        )
        if (startIdx >= endPeak) break

        let min = 0
        let max = 0
        for (let i = startIdx; i < endIdx; i++) {
          const lo = lanePeaks[i * 2]!
          const hi = lanePeaks[i * 2 + 1]!
          if (lo < min) min = lo
          if (hi > max) max = hi
        }

        // Scale the column's vertical excursion by the clip's volume
        // envelope at this time so the rendered waveform visibly shrinks or
        // grows with the gain shape (a fade-out tapers toward nothing, a
        // boost fills the lane). With no envelope `columnGain` is omitted and
        // the lane draws at its natural amplitude (see waveformColumn.ts).
        const colGain = columnGain ? columnGain(px) : 1
        const { up, down } = waveformColumnExcursion(min, max, laneHalf, colGain)
        const yTop = laneMidY - up
        const yBot = laneMidY + down
        target.moveTo(absX + px + 0.5, yTop).lineTo(absX + px + 0.5, yBot < yTop + 1 ? yTop + 1 : yBot)
        didDraw = true
      }
      return didDraw
    }

    // Volume envelope reflection: a per-column gain multiplier derived from
    // the clip's persisted gain shape (clip-local post-warp ms, the same
    // basis `w` spans). The envelope is sampled at each column's pixel centre
    // (`(px + 0.5) / w`) so steep fades aren't biased by up to a pixel.
    // Passed to `drawLane` so both the single summary lane and the stereo
    // channel lanes render at the clip's volume level. Omitted when the clip
    // has no envelope so unenveloped clips draw unchanged.
    const envPoints = clip.envelopePoints
    const volumeColumnGain =
      envPoints && envPoints.length >= 2 && effectiveDurMs > 0 && w > 0
        ? (px: number): number =>
            envelopeGainAtMs(envPoints, Math.min(effectiveDurMs, ((px + 0.5) / w) * effectiveDurMs))
        : undefined

    if (wantStereo && channelEntry) {
      // Two stacked half-height lanes (left on top, right below), each
      // reading from its own LOD pyramid so a column still covers ~1–2
      // peaks at the current zoom. Per-channel pan is reflected visually:
      // an equal-power pan law gives each channel a gain, normalised so
      // the louder channel stays full-height. A panned-away channel is
      // drawn shorter and more faded so the user can see the clip is
      // altered per channel.
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
        const laneGfx = new G()
        const drew = drawLane(
          laneGfx,
          lanePeaks,
          lanePps,
          innerY + laneH * ch + laneH / 2,
          fullHalf * gain,
          volumeColumnGain
        )
        if (drew) {
          laneGfx.stroke({ color: waveColour, width: 1, alpha: 0.95 * (0.25 + 0.75 * gain) })
          tracksL.addChild(laneGfx)
        }
      }
    } else {
      const wave = new G()
      if (drawLane(wave, peaks, peaksPerSecond, midY, innerH / 2 - 2, volumeColumnGain)) {
        wave.stroke({ color: waveColour, width: 1, alpha: 0.95 })
        tracksL.addChild(wave)
      }
    }

    // Beat markers — synthesised on a *source-global* beat grid so a
    // split clip's right half keeps in lockstep with its left half.
    //
    // The grid is anchored on the first detected beat (`beats[0]`) and
    // spaced by `60 / sourceBpm` seconds. Each clip windows that
    // shared grid by its trim range, finding the smallest synthetic
    // beat ≥ `inMs` and stepping forward from there. Picking the
    // first *detected* beat ≥ inMs (the old behaviour) wobbled by a
    // few ms after a split because BTrack's per-beat timestamps
    // wander relative to the implied uniform tempo.
    const beats = libItem?.beats
    const markerSourceBpm = libItem ? libraryItemSourceBpm(libItem, library.byId) : undefined
    // Non-musical "sample" library items (auto-detected from a poor
    // BPM-fit confidence, or explicitly set by the user) suppress the
    // synthetic beat-marker grid even when BTrack returned numbers —
    // those numbers don't correspond to anything the user wants to
    // see overlaid on the waveform.
    const treatAsSample = libItem ? libraryItemIsSample(libItem, library.byId) : false
    // Prefer the regression-derived anchor over the first raw
    // detected beat — it's the implied phase of the ideal beat
    // grid and is robust to BTrack's per-beat jitter. Older saved
    // projects without the anchor fall back to `beats[0]`.
    const anchorSec = libItem?.beatAnchorSec ?? beats?.[0]
    if (!treatAsSample && beats && beats.length > 0 && markerSourceBpm && markerSourceBpm > 0 && anchorSec !== undefined && w > 0) {
      const pxPerMs = pxPerSecond.value / 1000
      const inMs = clip.inMs
      const outMs = inMs + clip.durationMs
      const beatSpacingMs = (60 / markerSourceBpm) * 1000
      const universalAnchorMs = anchorSec * 1000
      // First synthetic beat ≥ inMs. ceil() can produce a value < inMs
      // when `(inMs - universalAnchorMs)` is exactly on a beat, so we
      // bump by spacing once if needed.
      let firstBeatMs =
        universalAnchorMs +
        Math.ceil((inMs - universalAnchorMs) / beatSpacingMs) * beatSpacingMs
      while (firstBeatMs < inMs) firstBeatMs += beatSpacingMs
      const minMarkerSpacingPx = 4
      const markers = new G()
      let drew = 0
      // Stride-step: when zoomed out, the per-beat loop would iterate
      // every beat in the clip just to skip 95% of them via the
      // `minMarkerSpacingPx` guard. Pre-compute the integer stride
      // (in beats) that already satisfies the min-spacing rule and
      // step by that, so a 5-minute clip at 120 BPM doesn't burn 600
      // iterations per redraw when only a handful of markers fit.
      // `pxPerBeat = beatSpacingMs / warpRatio * pxPerMs` is the on-
      // screen distance between successive beats.
      const pxPerBeat = (beatSpacingMs / warpRatio) * pxPerMs
      const beatStride =
        pxPerBeat > 0 ? Math.max(1, Math.ceil(minMarkerSpacingPx / pxPerBeat)) : 1
      const stepMs = beatSpacingMs * beatStride
      for (let beatMs = firstBeatMs; beatMs <= outMs; beatMs += stepMs) {
        const offsetInClipMs = beatMs - inMs
        if (offsetInClipMs < 0) continue
        const x = absX + (offsetInClipMs / warpRatio) * pxPerMs
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

  /**
   * Draw the crossfade overlays for a track's sanctioned transitions
   * (§12.1). Each transition's overlap region is DERIVED from the two
   * partner clips' live timeline geometry (never stored), so we resolve
   * the clips and recompute the region every paint — matching the backend,
   * which does the same. The marker is an equal-power "X" (two crossing
   * diagonals) over a faint fill, mirroring the `cos`/`sin` crossfade the
   * engine applies.
   */
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

      // Overlap region = [right.start, left.end] in timeline ms, using the
      // warp-scaled footprint (never the raw source duration).
      const overlapStartMs = right.startMs
      const overlapEndMs = left.startMs + effectiveClipDurationMs(left)
      if (overlapEndMs - overlapStartMs <= 0) continue

      const x0 = headerWidth() + (overlapStartMs / 1000) * pxPerSecond.value
      const x1 = headerWidth() + (overlapEndMs / 1000) * pxPerSecond.value
      const w = x1 - x0
      if (w <= 0) continue
      // Cull anything entirely outside the viewport (+ margin).
      if (x1 < worldLeft || x0 > worldRight) continue

      const overlay = new G()
      overlay
        .roundRect(x0, innerY, w, innerH, 3)
        .fill({ color: TRANSITION_FILL, alpha: TRANSITION_FILL_ALPHA })
      // Equal-power "X": two crossing diagonals spanning the overlap.
      overlay
        .moveTo(x0, innerY + innerH)
        .lineTo(x1, innerY)
        .moveTo(x0, innerY)
        .lineTo(x1, innerY + innerH)
        .stroke({ color: TRANSITION_LINE, width: 1.5, alpha: TRANSITION_LINE_ALPHA })
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

    // Library-item + source-BPM lookups are passed in from `drawClip` so
    // both functions share a single resolution per clip per redraw.
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

    // Prefer the clip's own custom name (set via inline rename on the
    // timeline) first. Otherwise fall back to the parent library
    // item's display name, then to the clip's filename.
    const displayName = clip.name?.trim()
      ? clip.name
      : libItem ? libraryItemDisplayName(libItem) : clip.fileName

    // Reserve room on the right for timeline status badges so the text
    // doesn't slide under them. Use the actual Pixi text measurement
    // rather than a character-count approximation because bold
    // proportional glyphs can be much wider than the average.
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
    const headerBg = new G()
    headerBg
      .rect(clipX, clipInnerY, desiredW, HEADER_H)
      .fill({ color: palette.border, alpha: 0.95 })
    tracksL.addChild(headerBg)

    label.x = Math.round(clipX + PAD_X)
    label.y = Math.round(clipInnerY + (HEADER_H - FONT_SIZE) / 2 - 1)
    if (label.text.length > 0) tracksL.addChild(label)

    let badgeRight = clipX + desiredW - PAD_X
    if (isLinked) {
      const badge = new G()
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
      // Compact padlock glyph: rounded body + shackle arc. Drawn into
      // the badge slot to match the visual weight of LINK/WARP/PITCH.
      const cx = badgeRight - LOCK_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      const bg = new G()
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
      const glyph = new G()
      // Padlock body — small rounded rect, centred.
      const bodyW = 6
      const bodyH = 5
      const bodyX = cx - bodyW / 2
      const bodyY = cy - 1
      glyph.roundRect(bodyX, bodyY, bodyW, bodyH, 1).fill({ color: 0xffffff })
      tracksL.addChild(glyph)
      // Shackle — open arc sitting on top of the body. Drawn on its own
      // Graphics with an explicit moveTo so Pixi does not stroke an
      // implicit line from the previous sub-path origin to the arc start.
      const shackle = new G()
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
      const bg = new G()
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
      const badge = new G()
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
      const bg = new G()
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

  return { drawClip, drawTrackTransitions }
}
