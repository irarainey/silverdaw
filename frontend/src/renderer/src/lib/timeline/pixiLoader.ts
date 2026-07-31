// Shared PixiJS module loader. Both the timeline renderer (`usePixiApp`) and the clip-editor
// scene (`useClipEditorScene`) go through this single cached import, so the large Pixi chunk is
// parsed once and the CSP-safe `unsafe-eval` shader patch is applied exactly once before any
// WebGL init. It also lets startup warm the chunk in the background (see `warmPixi`) so the first
// timeline/clip-editor draw never pays the import/parse cost on the interaction critical path.
import { log } from '@/lib/log'

let pixiPromise: Promise<typeof import('pixi.js')> | null = null
let importStartedAtMs = 0
let importDoneAtMs = 0

export function loadPixi(): Promise<typeof import('pixi.js')> {
  if (!pixiPromise) {
    importStartedAtMs = performance.now()
    pixiPromise = (async () => {
      // Apply the CSP-safe shader patch before WebGL init.
      // @ts-expect-error -- pixi.js/unsafe-eval has no published .d.ts; it's side-effect-only.
      await import('pixi.js/unsafe-eval')
      const mod = await import('pixi.js')
      importDoneAtMs = performance.now()
      log.info('perf', `pixi module import ${Math.round(importDoneAtMs - importStartedAtMs)}ms`)
      return mod
    })().catch((err: unknown) => {
      // Drop the cached promise on failure so a later call can retry (a rejected promise
      // would otherwise be handed to every subsequent caller forever).
      pixiPromise = null
      throw err
    })
  }
  return pixiPromise
}

/**
 * Shared `Application.init` options for every Pixi surface.
 *
 * `preference: 'webgl'` is deliberate and load-bearing. Pixi 8 defaults to probing
 * WebGPU first and only then falling back to WebGL, and that probe costs hundreds of
 * milliseconds in Electron before the canvas can paint. The renderer is WebGL-only by
 * design anyway: the CSP shader patch above targets WebGL, and context loss is handled
 * through the `webglcontextlost` event, which a WebGPU renderer would never raise.
 */
export function pixiInitOptions(background: number, host: HTMLElement): {
  background: number
  antialias: boolean
  resizeTo: HTMLElement
  autoDensity: boolean
  resolution: number
  preference: 'webgl'
} {
  return {
    background,
    antialias: true,
    resizeTo: host,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    preference: 'webgl'
  }
}

/**
 * Kick the Pixi import in the background, after first paint, while the startup screen is shown.
 * Idle-scheduled so it never competes with shell paint; a failure here is harmless because the
 * timeline/clip-editor retries the load on mount.
 *
 * Resolves once the import has settled, so the shell can then mount the timeline behind the
 * startup overlay and pay the (much larger) WebGL context-creation cost off the open-project
 * critical path.
 */
export function warmPixi(): Promise<void> {
  return new Promise<void>((resolve) => {
    const run = (): void => {
      log.info('perf', `pixi warm import kicked @ ${Math.round(performance.now())}ms`)
      void loadPixi()
        .catch(() => {})
        .finally(() => resolve())
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 2000 })
    } else {
      setTimeout(run, 200)
    }
  })
}
