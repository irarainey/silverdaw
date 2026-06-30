// Clip Editor waveform renderer (PixiJS) and hi-res peak request adapter.
//
// Mirrors the timeline renderer: the waveform is a batched Pixi `Mesh`, static
// chrome and time-anchored content live on separate layers, and horizontal
// scroll/playback translate the already-built band (an O(1) layer move) instead
// of repainting. A full `redraw()` only runs on content, zoom, selection or
// scroll-past-the-overscan changes; the playhead moves every frame for free.
// Inputs are getters so imperative draws read current reactive values.
//
// This composable owns the Pixi scene, pooled graphics/text, the redraw
// scheduler, and lifecycle; the individual draw passes live in
// `clipEditorWaveformPasses`.
import type { Graphics, Text } from 'pixi.js'
import { send as sendBridge } from '@/lib/bridgeService'
import { createRedrawScheduler } from '@/lib/timeline/useRedrawScheduler'
import { exceedsRebuildThreshold } from '@/lib/timeline/timelineWindow'
import { createWaveMeshBuilder } from '@/lib/clipEditor/clipEditorWaveMesh'
import { useClipEditorScene } from '@/lib/clipEditor/useClipEditorScene'
import type {
  ClipEditorWaveform,
  ClipEditorWaveformDeps,
  SceneGeometry
} from './clipEditorWaveformTypes'
import { RULER_H } from './clipEditorWaveformGeometry'
import { COL_PLAYHEAD, RULER_LABEL_STYLE } from './clipEditorWaveformTheme'
import { createClipEditorWaveformPasses } from './clipEditorWaveformPasses'

export type { ClipEditorWaveform, ClipEditorWaveformDeps } from './clipEditorWaveformTypes'

/** Backend rendering resolution requested when the user zooms in. */
const EDITOR_HI_RES_PEAKS_PER_SECOND = 2000
const EDITOR_HI_RES_ZOOM_THRESHOLD = 4

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

  const passes = createClipEditorWaveformPasses({
    deps,
    acquireGraphics,
    acquireText,
    meshBuilder
  })

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

    passes.drawRulerBackground(rulerBg, g)
    passes.drawWaveform(world, src, g)
    passes.drawBeatGrid(world, src, g)
    passes.drawRulerTicks(rulerTicks, g)
    passes.drawSelection(world, g)
    passes.drawSliceMarkers(world, g)
    passes.drawVolumeOverlay(world, g)

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
