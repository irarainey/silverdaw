// Shared PixiJS module loader. Both the timeline renderer (`usePixiApp`) and the clip-editor
// scene (`useClipEditorScene`) go through this single cached import, so the large Pixi chunk is
// parsed once and the CSP-safe `unsafe-eval` shader patch is applied exactly once before any
// WebGL init. It also lets startup warm the chunk in the background (see `warmPixi`) so the first
// timeline/clip-editor draw never pays the import/parse cost on the interaction critical path.

let pixiPromise: Promise<typeof import('pixi.js')> | null = null

export function loadPixi(): Promise<typeof import('pixi.js')> {
  if (!pixiPromise) {
    pixiPromise = (async () => {
      // Apply the CSP-safe shader patch before WebGL init.
      // @ts-expect-error -- pixi.js/unsafe-eval has no published .d.ts; it's side-effect-only.
      await import('pixi.js/unsafe-eval')
      return import('pixi.js')
    })().catch((err: unknown) => {
      // Drop the cached promise on failure so a later call can retry (a rejected promise
      // would otherwise be handed to every subsequent caller forever).
      pixiPromise = null
      throw err
    })
  }
  return pixiPromise
}

// Kick the Pixi import in the background, after first paint, while the startup screen is shown.
// Idle-scheduled so it never competes with shell paint; a failure here is harmless because the
// timeline/clip-editor retries the load on mount.
export function warmPixi(): void {
  const run = (): void => {
    void loadPixi().catch(() => {})
  }
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2000 })
  } else {
    setTimeout(run, 200)
  }
}
