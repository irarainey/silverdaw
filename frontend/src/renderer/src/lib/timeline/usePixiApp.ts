// PixiJS Application lifecycle for the timeline canvas.
//
// Responsibilities:
//  - Lazy-load PixiJS (so the title bar + transport bar render before the
//    ~500 KB pixi bundle finishes parsing).
//  - Apply the `pixi.js/unsafe-eval` shim (Electron's renderer disallows
//    `unsafe-eval`) BEFORE constructing the WebGL renderer.
//  - Build the four scene-graph layers (ruler / tracks / headers /
//    playhead) and append the canvas to the host element.
//  - Resize the renderer to match the host's actual layout size on mount
//    and on every `ResizeObserver` tick, writing the new viewport size
//    into the scroll composable so geometry recomputes correctly.
//  - Tear everything down on unmount.
//
// The composable owns the dynamic PixiJS imports so the rest of the
// timeline code can stay synchronous and import-free at module load.

import { onBeforeUnmount, onMounted, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import type { Application, Container, Graphics, Text } from 'pixi.js'
import { BG } from './constants'

export interface PixiApp {
  /** True once `Application.init()` has resolved and the layers exist. */
  isReady: Ref<boolean>
  /** PixiJS Application instance (null until ready). */
  app: ShallowRef<Application | null>
  /** Static ruler chrome — bg + header-corner. Never translated. */
  rulerLayer: ShallowRef<Container | null>
  /** Ruler tick lines + bar/beat labels. Translated by `-scrollX` only. */
  rulerTicksLayer: ShallowRef<Container | null>
  /** Track-area content (row bgs, grid, clip blocks + waveforms + filename
   *  labels). Translated by `-scrollX, -scrollY`. */
  tracksLayer: ShallowRef<Container | null>
  /** Header column chrome (column bg, per-track header bgs, divider).
   *  Never translated — sits visually pinned over the track area's left edge. */
  headersLayer: ShallowRef<Container | null>
  /** Playhead Graphics, built once and re-positioned via `.x`. */
  playheadLayer: ShallowRef<Container | null>
  /** PixiJS constructors. Null until ready; used by the drawing code. */
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  ContainerCtor: ShallowRef<typeof Container | null>
  TextCtor: ShallowRef<typeof Text | null>
}

export interface PixiAppOptions {
  /** Host `<div>` the canvas is mounted into. */
  host: Ref<HTMLElement | null>
  /** Reactive viewport width — written on init and on each resize tick. */
  viewportWidth: Ref<number>
  /** Reactive viewport height — written on init and on each resize tick. */
  viewportHeight: Ref<number>
  /**
   * Fires after the renderer has been resized and viewport refs updated,
   * so the host component can re-clamp scroll and repaint.
   */
  onResize: () => void
  /**
   * Fires once after init completes, so the host can trigger the very
   * first `redraw()` / `updatePlayhead()` pass.
   */
  onReady: () => void
}

export function usePixiApp(opts: PixiAppOptions): PixiApp {
  const isReady = ref(false)
  const app = shallowRef<Application | null>(null)
  const rulerLayer = shallowRef<Container | null>(null)
  const rulerTicksLayer = shallowRef<Container | null>(null)
  const tracksLayer = shallowRef<Container | null>(null)
  const headersLayer = shallowRef<Container | null>(null)
  const playheadLayer = shallowRef<Container | null>(null)
  const GraphicsCtor = shallowRef<typeof Graphics | null>(null)
  const ContainerCtor = shallowRef<typeof Container | null>(null)
  const TextCtor = shallowRef<typeof Text | null>(null)

  let resizeObserver: ResizeObserver | null = null

  onMounted(async () => {
    if (!opts.host.value) return

    // Lazy-load PixiJS so the title bar + transport bar render before the
    // ~500 KB pixi bundle finishes parsing. Also apply the CSP-safe
    // shader patch (Electron's renderer disallows `unsafe-eval`) before
    // constructing the WebGL renderer.
    // @ts-expect-error -- pixi.js/unsafe-eval has no published .d.ts; it's side-effect-only.
    await import('pixi.js/unsafe-eval')
    const pixi = await import('pixi.js')
    GraphicsCtor.value = pixi.Graphics
    ContainerCtor.value = pixi.Container
    TextCtor.value = pixi.Text

    // The component could have unmounted while pixi was loading.
    if (!opts.host.value) return

    const instance = new pixi.Application()
    await instance.init({
      background: BG,
      antialias: true,
      resizeTo: opts.host.value,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1
    })

    // And again — host might have unmounted while init was awaiting.
    if (!opts.host.value) {
      instance.destroy(true, { children: true, texture: true })
      return
    }

    app.value = instance
    opts.host.value.appendChild(instance.canvas)
    instance.canvas.style.display = 'block'

    // Force the renderer to match the host's current layout size.
    // PixiJS's `resizeTo` reacts to window resize but not to flex/layout
    // settling, and during init the host may not yet have its final
    // width. Without this the draw-coordinate space can lag the canvas
    // CSS size, leaving the right ~25 % of the canvas empty.
    const initW = opts.host.value.clientWidth
    const initH = opts.host.value.clientHeight
    if (initW > 0 && initH > 0) {
      instance.renderer.resize(initW, initH)
      opts.viewportWidth.value = initW
      opts.viewportHeight.value = initH
    }

    rulerLayer.value = new pixi.Container()
    rulerTicksLayer.value = new pixi.Container()
    tracksLayer.value = new pixi.Container()
    // Headers drawn after tracks so the divider sits above scrolled clip
    // content (future).
    headersLayer.value = new pixi.Container()
    // Playhead above everything so it stays visible over clips + headers.
    playheadLayer.value = new pixi.Container()

    // Z-order:
    //   rulerLayer        — static ruler bg + corner (under everything below)
    //   tracksLayer       — translated world content (row bgs, grid, clips)
    //   rulerTicksLayer   — translated ruler ticks/labels, on top of tracks
    //                       so they overlay the (potentially scrolled-up)
    //                       row backgrounds at y < RULER_HEIGHT
    //   headersLayer      — track-header column, pinned, masks scrolled rows
    //   playheadLayer     — the playhead, on top of everything
    instance.stage.addChild(rulerLayer.value)
    instance.stage.addChild(tracksLayer.value)
    instance.stage.addChild(rulerTicksLayer.value)
    instance.stage.addChild(headersLayer.value)
    instance.stage.addChild(playheadLayer.value)

    isReady.value = true
    opts.onReady()

    // PixiJS's `resizeTo` only reacts to window resize events, not to
    // layout changes of the host element (flex settling, dev tools open,
    // sibling bar reflow, etc.). We resize explicitly here so the draw
    // coordinate space tracks the canvas's CSS size.
    resizeObserver = new ResizeObserver(() => {
      const a = app.value
      if (!a || !opts.host.value) return
      const w = opts.host.value.clientWidth
      const h = opts.host.value.clientHeight
      if (w > 0 && h > 0) {
        a.renderer.resize(w, h)
        opts.viewportWidth.value = w
        opts.viewportHeight.value = h
      }
      opts.onResize()
      // ResizeObserver callbacks run after layout but before the browser
      // paints the frame. Force an immediate render so the freshly-resized
      // canvas is painted with content in this same frame. Without this a
      // large one-shot size change (e.g. collapsing/expanding the bottom
      // panel) leaves a single blank frame that reads as a flicker across
      // the timeline; the incremental resizes from dragging a handle never
      // expose enough blank area to notice.
      a.render()
    })
    resizeObserver.observe(opts.host.value)
  })

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    resizeObserver = null
    app.value?.destroy(true, { children: true, texture: true })
    app.value = null
    rulerLayer.value = null
    rulerTicksLayer.value = null
    tracksLayer.value = null
    headersLayer.value = null
    playheadLayer.value = null
    isReady.value = false
  })

  return {
    isReady,
    app,
    rulerLayer,
    rulerTicksLayer,
    tracksLayer,
    headersLayer,
    playheadLayer,
    GraphicsCtor,
    ContainerCtor,
    TextCtor
  }
}
