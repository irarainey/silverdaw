// PixiJS application lifecycle and layer setup for the timeline canvas.

import { onBeforeUnmount, onMounted, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import type { Application, Container, Graphics, Mesh, MeshGeometry, Text, Texture } from 'pixi.js'
import { BG } from './constants'
import { log } from '@/lib/log'

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
  /** Mesh + geometry constructors for the batched waveform renderer. */
  MeshCtor: ShallowRef<typeof Mesh | null>
  MeshGeometryCtor: ShallowRef<typeof MeshGeometry | null>
  /** Shared 1×1 white texture; waveform meshes tint it to the wave colour. */
  whiteTexture: ShallowRef<Texture | null>
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
  const MeshCtor = shallowRef<typeof Mesh | null>(null)
  const MeshGeometryCtor = shallowRef<typeof MeshGeometry | null>(null)
  const whiteTexture = shallowRef<Texture | null>(null)

  let resizeObserver: ResizeObserver | null = null
  let pixiNs: typeof import('pixi.js') | null = null
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  let rebuildAttempts = 0
  let destroyed = false
  // Cap the back-off retries so a permanently broken GPU can't loop forever.
  const MAX_REBUILD_ATTEMPTS = 8

  async function loadPixi(): Promise<typeof import('pixi.js')> {
    if (!pixiNs) {
      // Lazy-load PixiJS and apply the CSP-safe shader patch before WebGL init.
      // @ts-expect-error -- pixi.js/unsafe-eval has no published .d.ts; it's side-effect-only.
      await import('pixi.js/unsafe-eval')
      pixiNs = await import('pixi.js')
    }
    return pixiNs
  }

  // A Windows GPU reset (TDR) — which htdemucs DirectML stem separation can
  // trigger — loses the WebGL context backing this canvas, blanking the timeline.
  // In Electron a GPU-process crash fires no `webglcontextrestored`, so the canvas
  // would stay white forever. Tear the Pixi app down and rebuild it on a fresh
  // context instead, retrying with back-off while the GPU is still recovering.
  function handleContextLost(event: Event): void {
    event.preventDefault()
    isReady.value = false
    app.value?.ticker?.stop()
    log.warn('timeline', 'WebGL context lost (likely a GPU reset); rebuilding the timeline renderer.')
    scheduleRebuild(400)
  }

  function scheduleRebuild(delayMs: number): void {
    if (destroyed || rebuildTimer) return
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null
      void rebuild(delayMs)
    }, delayMs)
  }

  async function rebuild(prevDelayMs: number): Promise<void> {
    if (destroyed || !opts.host.value) return
    teardownApp()
    const ok = await buildApp()
    if (destroyed) return
    if (ok) {
      rebuildAttempts = 0
      log.info('timeline', 'Timeline renderer rebuilt after WebGL context loss.')
      return
    }
    rebuildAttempts += 1
    if (rebuildAttempts <= MAX_REBUILD_ATTEMPTS) {
      scheduleRebuild(Math.min(prevDelayMs * 2, 4000))
    } else {
      log.error('timeline', 'Gave up rebuilding the timeline renderer after repeated WebGL failures.')
    }
  }

  function teardownApp(): void {
    const instance = app.value
    if (instance) {
      const canvas = instance.canvas
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      try {
        // Destroying GPU resources on an already-lost context can throw; guard so
        // teardown always completes and the canvas is removed (avoids stacked,
        // flickering leftover canvases across rebuilds).
        //
        // The renderer-destroy options are `{ removeView: true }`, NOT `true`.
        // Passing `true` makes Pixi call `GlobalResourceRegistry.release()`, which
        // destroys the PROCESS-GLOBAL batch pool (and texture/canvas pools) shared
        // by every live PixiJS renderer. While the clip-editor renderer is open,
        // that nukes Batch objects its render still references — and vice-versa:
        // the clip-editor closing while this timeline is alive would leave the
        // timeline's cached instructions holding a destroyed Batch with a null
        // `batcher`, throwing in `BatcherPipe.execute` inside the auto-ticker and
        // freezing the canvas black. `{ removeView: true }` removes the canvas
        // without releasing those shared globals (they persist for the process,
        // which is fine for a long-lived app).
        //
        // `texture: false` is also deliberate: the waveform meshes tint the
        // PROCESS-GLOBAL `Texture.WHITE` singleton, which is ALSO used by the
        // clip-editor renderer. Passing `texture: true` here would destroy that
        // shared singleton's GPU source on teardown/rebuild, leaving every Mesh in
        // both surfaces sampling a dead texture — invisible (black) forever, with
        // no error and no recovery. The clip-editor teardown uses the same options
        // for the same reasons.
        instance.destroy({ removeView: true }, { children: true, texture: false })
      } catch (err) {
        log.warn('timeline',
          `Pixi teardown error (continuing): ${err instanceof Error ? err.message : String(err)}`)
        canvas.remove()
      }
    }
    app.value = null
    rulerLayer.value = null
    rulerTicksLayer.value = null
    tracksLayer.value = null
    headersLayer.value = null
    playheadLayer.value = null
    isReady.value = false
  }

  async function buildApp(): Promise<boolean> {
    if (!opts.host.value) return false
    try {
      const pixi = await loadPixi()
      GraphicsCtor.value = pixi.Graphics
      ContainerCtor.value = pixi.Container
      TextCtor.value = pixi.Text
      MeshCtor.value = pixi.Mesh
      MeshGeometryCtor.value = pixi.MeshGeometry
      whiteTexture.value = pixi.Texture.WHITE

      // The component could have unmounted while pixi was loading.
      if (destroyed || !opts.host.value) return false

      const instance = new pixi.Application()
      await instance.init({
        background: BG,
        antialias: true,
        resizeTo: opts.host.value,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1
      })

      // And again — host might have unmounted while init was awaiting.
      if (destroyed || !opts.host.value) {
        // `{ removeView: true }` (not `true`) and `texture: false` for the same
        // shared-global reasons as in `teardownApp` — never release the global
        // batch pool or destroy the process-global white singleton.
        instance.destroy({ removeView: true }, { children: true, texture: false })
        return false
      }

      app.value = instance
      opts.host.value.appendChild(instance.canvas)
      instance.canvas.style.display = 'block'
      instance.canvas.addEventListener('webglcontextlost', handleContextLost)

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
      return true
    } catch (err) {
      log.error('timeline',
        `Pixi renderer build failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  onMounted(async () => {
    const ok = await buildApp()
    if (!ok || destroyed || !opts.host.value) return

    // ResizeObserver keeps draw coordinates aligned with the canvas CSS size.
    // It survives renderer rebuilds — its callback reads the current `app.value`.
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
    destroyed = true
    if (rebuildTimer) {
      clearTimeout(rebuildTimer)
      rebuildTimer = null
    }
    resizeObserver?.disconnect()
    resizeObserver = null
    teardownApp()
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
    TextCtor,
    MeshCtor,
    MeshGeometryCtor,
    whiteTexture
  }
}
