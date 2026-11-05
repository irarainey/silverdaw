import type { Container } from 'pixi.js'

type SceneResource = Pick<Container, 'destroy' | 'destroyed'>
type SceneLayer = { removeChildren: () => SceneResource[] }

const destroyOptions = { children: true, context: true, texture: false, textureSource: false }

/** Separate frame-owned layer children from pooled resources, including detached surplus. */
export function createTimelineSceneResources() {
  const pooled = new Map<SceneResource, (() => void) | undefined>()

  function retain<T extends SceneResource>(resource: T, disposeOwnedData?: () => void): T {
    pooled.set(resource, disposeOwnedData)
    return resource
  }

  function clearLayer(layer: SceneLayer): void {
    for (const child of layer.removeChildren()) {
      if (!pooled.has(child) && !child.destroyed) child.destroy(destroyOptions)
    }
  }

  function dispose(): void {
    for (const [resource, disposeOwnedData] of pooled) {
      if (!resource.destroyed) resource.destroy(destroyOptions)
      disposeOwnedData?.()
    }
    pooled.clear()
  }

  return { retain, clearLayer, dispose }
}

export type TimelineSceneResources = ReturnType<typeof createTimelineSceneResources>
