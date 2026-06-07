// PixiJS application lifecycle and layer setup for the timeline canvas.

import { onBeforeUnmount, onMounted, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import type { Application, Container, Graphics, Text } from 'pixi.js'
import { BG } from './constants'

export interface PixiApp {
  isReady: Ref<boolean>
  app: ShallowRef<Application | null>
  /** Static ruler chrome; never translated. */
  rulerLayer: ShallowRef<Container | null>
  /** Ruler ticks translated by `-scrollX`. */
  rulerTicksLayer: ShallowRef<Container | null>
  /** Track content translated by `-scrollX, -scrollY`. */
  tracksLayer: ShallowRef<Container | null>
  /** Header column chrome; never translated. */
  headersLayer: ShallowRef<Container | null>
  /** Cached playhead layer. */
  playheadLayer: ShallowRef<Container | null>
  /** PixiJS constructors, null until ready. */
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  ContainerCtor: ShallowRef<typeof Container | null>
  TextCtor: ShallowRef<typeof Text | null>
}

export interface PixiAppOptions {
  host: Ref<HTMLElement | null>
  viewportWidth: Ref<number>
  viewportHeight: Ref<number>
  /** Fires after resize so the host can clamp scroll and repaint. */
  onResize: () => void
  /** Fires once after init so the host can do its first paint. */
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

    // Lazy-load PixiJS and apply the CSP-safe shader patch before WebGL init.
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

    // Force draw coordinates to match flex/layout-settled host size.
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
    headersLayer.value = new pixi.Container()
    // Playhead stays above clips and headers.
    playheadLayer.value = new pixi.Container()

    // Z-order keeps pinned chrome and playhead above scrolled world content.
    instance.stage.addChild(rulerLayer.value)
    instance.stage.addChild(tracksLayer.value)
    instance.stage.addChild(rulerTicksLayer.value)
    instance.stage.addChild(headersLayer.value)
    instance.stage.addChild(playheadLayer.value)

    isReady.value = true
    opts.onReady()

    // ResizeObserver keeps draw coordinates aligned with the canvas CSS size.
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
      // Paint the resized scene in the same frame to avoid a blank flash.
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
