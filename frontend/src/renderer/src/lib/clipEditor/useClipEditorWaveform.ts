// Clip Editor waveform renderer + hi-res peaks request, extracted from
// ClipEditorDialog.vue to keep the SFC focused on orchestration. This is a
// Vue-facing adapter, not a pure module: it owns the on-demand hi-res request
// de-dup key and writes one piece of shared state — `waveformStereoLanes` —
// which the SFC owns (passed in as a mutable ref) because the canvas pointer
// hit-testing reads the *last rendered* lane layout.
//
// Reactive inputs are passed as getters so reads happen at call time; the
// renderer is invoked imperatively (from the SFC's watchers / RAF), so this
// preserves reactivity without moving any `watch` out of the SFC.
import type { Ref } from 'vue'
import { send as sendBridge } from '@/lib/bridgeService'
import { pickPeaksLod } from '@/lib/peaksLod'
import { envelopeGainAtMs } from '@/lib/envelope'
import { overlayGainToY, volumeOverlayLanes, volumeTimeToSourceMs } from '@/lib/clipEditor/volumeOverlay'
import type {
  EditorHiResPeaks,
  ItemChannelPeaks,
  LibraryItem
} from '@/stores/libraryStore'
import type { ClipEnvelopePoint } from '@shared/bridge-protocol'

/** Backend rendering resolution requested when the user zooms in. */
const EDITOR_HI_RES_PEAKS_PER_SECOND = 2000
/** Minimum CSS-px height each stereo lane needs before the Clip Editor splits
 *  the waveform into stacked left / right lanes. Below twice this, it falls
 *  back to the single summary lane. */
const EDITOR_MIN_STEREO_LANE_PX = 24
const EDITOR_HI_RES_ZOOM_THRESHOLD = 4

export interface ClipEditorWaveformDeps {
  getCanvas: () => HTMLCanvasElement | null
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
  editorHiResPeaks: () => EditorHiResPeaks | null
  channelPeaksByItemId: () => Record<string, ItemChannelPeaks>
  waveformDisplayMode: () => 'summary' | 'stereo'
  /** Owned by the SFC; the renderer writes the last-rendered lane layout here
   *  so the pointer geometry matches what was drawn. */
  waveformStereoLanes: Ref<boolean>
}

export interface ClipEditorWaveform {
  drawWaveform: () => void
  ensureEditorHiResPeaks: () => void
  resetHiResRequestKey: () => void
}

export function useClipEditorWaveform(deps: ClipEditorWaveformDeps): ClipEditorWaveform {
  let lastHiResRequestKey = ''

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

  function drawWaveform(): void {
    const canvas = deps.getCanvas()
    if (!canvas) return
    const src = deps.sourceItem()
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

    const sourceTotal = deps.sourceDurationMs()
    const vIn = deps.visibleInMs()
    const vDur = deps.visibleDurationMs()
    const vEnd = deps.visibleEndMs()
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
        const label = formatRulerTime(t - deps.viewInMs(), majorMs)
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
    const hiRes = deps.editorHiResPeaks()
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

    // Draw a single waveform lane from `lanePeaks` centred on `laneMid`
    // with a half-height of `laneHalfH`. Shared by the summary lane and
    // the two stereo lanes so the column-mapping math stays identical.
    const drawWaveLane = (
      lanePeaks: Float32Array,
      lanePps: number,
      laneMid: number,
      laneHalfH: number
    ): void => {
      if (!(lanePeaks.length >= 2) || sourceTotal <= 0) return
      const pairs = Math.floor(lanePeaks.length / 2)
      // Map each canvas column to a peak index. When the LOD's actual
      // ppS is known, use it for a sample-accurate mapping (so transients
      // do not drift against the ruler/beat grid). Otherwise fall back
      // to the legacy proportional mapping over `sourceTotal`.
      const useRate = lanePps > 0
      const peakStart = useRate ? (vIn / 1000) * lanePps : (vIn / sourceTotal) * pairs
      const peakSpan = useRate ? (vDur / 1000) * lanePps : (vDur / sourceTotal) * pairs
      for (let x = 0; x < w; x++) {
        const i = Math.floor(peakStart + (x / w) * peakSpan)
        if (i < 0 || i >= pairs) continue
        const lo = lanePeaks[i * 2] || 0
        const hi = lanePeaks[i * 2 + 1] || 0
        const y0 = laneMid - hi * laneHalfH
        const y1 = laneMid - lo * laneHalfH
        ctx.fillRect(x, Math.min(y0, y1), 1, Math.max(1, Math.abs(y1 - y0)))
      }
    }

    // Stereo display: when the user has opted in AND this clip's source
    // has 2-channel peaks AND the wave band is tall enough, stack separate
    // L/R lanes; otherwise draw the single summary lane (the default).
    const channelSourceId =
      src.kind === 'saved-clip' ? src.derivedFrom?.sourceItemId : src.id
    const hiResChannels =
      usingHiRes && hiRes!.channels.length === 2 ? hiRes!.channels : undefined
    const channelEntry = channelSourceId
      ? deps.channelPeaksByItemId()[channelSourceId]
      : undefined
    const stereoAvailable = !!hiResChannels || (!!channelEntry && channelEntry.channels.length === 2)
    const wantStereo =
      deps.waveformDisplayMode() === 'stereo' && stereoAvailable && waveH >= EDITOR_MIN_STEREO_LANE_PX * 2 * dpr
    deps.waveformStereoLanes.value = wantStereo

    ctx.fillStyle = '#3b82f6'
    if (wantStereo) {
      const laneH = waveH / 2
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
        drawWaveLane(lanePeaks, lanePps, waveTop + laneH * ch + laneH / 2, laneHalfH)
      }
    } else if (peaks && peaks.length >= 2 && sourceTotal > 0) {
      drawWaveLane(peaks, peaksPerSec, waveMid, waveH / 2)
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
    const fullVIn = deps.viewInMs()
    const fullVEnd = deps.viewEndMs()
    const isSubSelection =
      deps.selectionInMs() > fullVIn + 0.5 || deps.selectionEndMs() < fullVEnd - 0.5
    const showHandles = !deps.editsExistingClip() || isSubSelection
    if (deps.selectionDurationMs() > 0 && showHandles) {
      const sx = msToX(deps.selectionInMs())
      const ex = msToX(deps.selectionEndMs())
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
    const px = msToX(deps.playheadAbsMs())
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
    if (deps.volumeShapeAvailable()) {
      const points = deps.draftPoints()
      const editing = deps.volumeEditActive()
      // The volume line is always visible as context; the Volume toggle only
      // controls whether it's editable (brighter line + grabbable handles).
      if (points.length >= 2) {
        const ratio = deps.draftEffectiveRatio() > 0 ? deps.draftEffectiveRatio() : 1
        const clipStartSourceMs = deps.viewInMs()
        const durMs = deps.volumeShapeDurationMs()
        const envX = (timelineMs: number): number =>
          msToX(volumeTimeToSourceMs(timelineMs, clipStartSourceMs, ratio))
        const xStart = envX(0)
        const xEnd = envX(durMs)
        const steps = Math.max(16, Math.round((xEnd - xStart) / (3 * dpr)))
        const r = (editing ? 4 : 2.5) * dpr

        // In stereo view the one shared envelope is mirrored into both the
        // left (upper) and right (lower) channel lanes so it reads against
        // each channel; in summary view it spans the full waveform height.
        const lanes = volumeOverlayLanes(waveTop, waveH, deps.waveformStereoLanes.value)
        for (const lane of lanes) {
          const envY = (gain: number): number => overlayGainToY(gain, lane.top, lane.height)

          // Unity (0 dB) reference line across the clip span.
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
  }

  return { drawWaveform, ensureEditorHiResPeaks, resetHiResRequestKey }
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
