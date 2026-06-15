// PixiJS application lifecycle and layer setup for the clip editor canvas.
//
// Mirrors the timeline's `usePixiApp`, but the clip editor lives inside a
// conditionally-rendered modal, so the Pixi app is built lazily when the dialog
// opens (`mount`) and torn down when it closes (`unmount`) rather than on
// component mount. Layer roles match the timeline so both surfaces draw the same
// way: a static ruler-background layer, world layers translated by `-scrollPx`,
// and a viewport-space playhead.

import { getCurrentInstance, onBeforeUnmount, shallowRef, type ShallowRef } from 'vue'
import type {
  Application,
  Container,
  Graphics,
  Mesh,
  MeshGeometry,
  Text,
  Texture
} from 'pixi.js'
import { log } from '@/lib/log'

/** Waveform-area background (zinc-950-ish); the ruler band paints over the top. */
const EDITOR_BG = 0x0a0a0a

export interface ClipEditorScene {
  isReady: ShallowRef<boolean>
  /** Static ruler-band chrome and the centre baseline; never translated. */
  rulerBgLayer: ShallowRef<Container | null>
  /** Waveform mesh, beat grid, selection and volume overlay; translated by -scrollPx. */
  worldLayer: ShallowRef<Container | null>
  /** Ruler ticks and labels; translated by -scrollPx. */
  rulerTicksLayer: ShallowRef<Container | null>
  /** Playhead in viewport coordinates; only its `x` changes per frame. */
  playheadLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  TextCtor: ShallowRef<typeof Text | null>
  MeshCtor: ShallowRef<typeof Mesh | null>
  MeshGeometryCtor: ShallowRef<typeof MeshGeometry | null>
  whiteTexture: ShallowRef<Texture | null>
  /** The Pixi-managed canvas element (for pointer hit-testing), or null. */
  getCanvas: () => HTMLCanvasElement | null
  /** CSS-pixel drawing width/height of the renderer. */
  screenWidth: () => number
  screenHeight: () => number
  /** Build the Pixi app on `host` if not already built. */
  mount: (host: HTMLElement) => Promise<void>
  /** Tear the Pixi app down and release GPU resources. */
  unmount: () => void
}

export interface ClipEditorSceneOptions {
  /** Fires after a resize once viewport dimensions have settled. */
  onResize: (width: number, height: number) => void
  /** Fires once the app is ready for its first paint. */
  onReady: () => void
}

export function useClipEditorScene(opts: ClipEditorSceneOptions): ClipEditorScene {
  const isReady = shallowRef(false)
  const rulerBgLayer = shallowRef<Container | null>(null)
  const worldLayer = shallowRef<Container | null>(null)
  const rulerTicksLayer = shallowRef<Container | null>(null)
  const playheadLayer = shallowRef<Container | null>(null)
  const GraphicsCtor = shallowRef<typeof Graphics | null>(null)
  const TextCtor = shallowRef<typeof Text | null>(null)
  const MeshCtor = shallowRef<typeof Mesh | null>(null)
  const MeshGeometryCtor = shallowRef<typeof MeshGeometry | null>(null)
  const whiteTexture = shallowRef<Texture | null>(null)

  let app: Application | null = null
  let pixiNs: typeof import('pixi.js') | null = null
  let resizeObserver: ResizeObserver | null = null
  let building = false

  async function loadPixi(): Promise<typeof import('pixi.js')> {
    if (!pixiNs) {
      // Lazy-load PixiJS and apply the CSP-safe shader patch before WebGL init.
      // @ts-expect-error -- pixi.js/unsafe-eval has no published .d.ts; side-effect-only.
      await import('pixi.js/unsafe-eval')
      pixiNs = await import('pixi.js')
    }
    return pixiNs
  }

  function getCanvas(): HTMLCanvasElement | null {
    return app?.canvas ?? null
  }

  function screenWidth(): number {
    return app?.renderer.screen.width ?? 0
  }

  function screenHeight(): number {
    return app?.renderer.screen.height ?? 0
  }

  function handleContextLost(event: Event): void {
    // A GPU reset blanks the canvas; mark not-ready so the next open rebuilds it.
    event.preventDefault()
    isReady.value = false
    log.warn('clipEditor', 'WebGL context lost on the clip editor canvas.')
  }

  async function mount(host: HTMLElement): Promise<void> {
    if (app || building) return
    building = true
    try {
      const pixi = await loadPixi()
      GraphicsCtor.value = pixi.Graphics
      TextCtor.value = pixi.Text
      MeshCtor.value = pixi.Mesh
      MeshGeometryCtor.value = pixi.MeshGeometry
      whiteTexture.value = pixi.Texture.WHITE

      const instance = new pixi.Application()
      await instance.init({
        background: EDITOR_BG,
        antialias: true,
        resizeTo: host,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1
      })

      app = instance
      host.appendChild(instance.canvas)
      instance.canvas.style.display = 'block'
      instance.canvas.addEventListener('webglcontextlost', handleContextLost)

      const initW = host.clientWidth
      const initH = host.clientHeight
      if (initW > 0 && initH > 0) instance.renderer.resize(initW, initH)

      rulerBgLayer.value = new pixi.Container()
      worldLayer.value = new pixi.Container()
      rulerTicksLayer.value = new pixi.Container()
      playheadLayer.value = new pixi.Container()
      instance.stage.addChild(rulerBgLayer.value)
      instance.stage.addChild(worldLayer.value)
      instance.stage.addChild(rulerTicksLayer.value)
      instance.stage.addChild(playheadLayer.value)

      resizeObserver = new ResizeObserver(() => {
        if (!app || !host.isConnected) return
        const w = host.clientWidth
        const h = host.clientHeight
        if (w > 0 && h > 0) {
          app.renderer.resize(w, h)
          opts.onResize(w, h)
          app.render()
        }
      })
      resizeObserver.observe(host)

      isReady.value = true
      opts.onReady()
    } catch (err) {
      log.error(
        'clipEditor',
        `Clip editor Pixi build failed: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      building = false
    }
  }

  function unmount(): void {
    resizeObserver?.disconnect()
    resizeObserver = null
    const instance = app
    if (instance) {
      instance.canvas.removeEventListener('webglcontextlost', handleContextLost)
      try {
        instance.destroy(true, { children: true, texture: false })
      } catch (err) {
        log.warn(
          'clipEditor',
          `Clip editor Pixi teardown error (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        instance.canvas.remove()
      }
    }
    app = null
    rulerBgLayer.value = null
    worldLayer.value = null
    rulerTicksLayer.value = null
    playheadLayer.value = null
    isReady.value = false
  }

  if (getCurrentInstance()) onBeforeUnmount(unmount)

  return {
    isReady,
    rulerBgLayer,
    worldLayer,
    rulerTicksLayer,
    playheadLayer,
    GraphicsCtor,
    TextCtor,
    MeshCtor,
    MeshGeometryCtor,
    whiteTexture,
    getCanvas,
    screenWidth,
    screenHeight,
    mount,
    unmount
  }
}
