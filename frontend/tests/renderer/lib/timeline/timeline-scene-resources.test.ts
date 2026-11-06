import { describe, expect, it, vi } from 'vitest'
import { createTimelineSceneResources } from '@/lib/timeline/timeline-scene-resources'

function resource() {
  return { destroyed: false, destroy: vi.fn() }
}

describe('timeline scene resources', () => {
  it('destroys detached frame-owned nodes while preserving pooled children across redraws', () => {
    const scene = createTimelineSceneResources()
    const pooled = scene.retain(resource())
    const text = resource()
    const graphics = resource()
    const layer = { removeChildren: vi.fn().mockReturnValueOnce([text, pooled, graphics]).mockReturnValueOnce([pooled]) }

    scene.clearLayer(layer)
    scene.clearLayer(layer)

    expect(text.destroy).toHaveBeenCalledOnce()
    expect(graphics.destroy).toHaveBeenCalledWith(expect.objectContaining({
      children: true, context: true, texture: false, textureSource: false
    }))
    expect(pooled.destroy).not.toHaveBeenCalled()
  })

  it('disposes detached surplus and owned mesh data once without destroying shared textures', () => {
    const scene = createTimelineSceneResources()
    const mesh = resource()
    const geometry = { destroy: vi.fn() }
    scene.retain(mesh, () => geometry.destroy(true))
    const surplus = scene.retain(resource())

    scene.dispose()
    scene.dispose()

    expect(mesh.destroy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ texture: false }))
    expect(surplus.destroy).toHaveBeenCalledOnce()
    expect(geometry.destroy).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('releases owned geometry even when application teardown already destroyed its mesh', () => {
    const scene = createTimelineSceneResources()
    const mesh = { ...resource(), destroyed: true }
    const disposeGeometry = vi.fn()
    scene.retain(mesh, disposeGeometry)

    scene.dispose()

    expect(mesh.destroy).not.toHaveBeenCalled()
    expect(disposeGeometry).toHaveBeenCalledOnce()
  })
})
