import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useClipEditorScene } from '@/lib/clipEditor/useClipEditorScene'

// The suite runs in the `node` environment (see vitest.config.ts), and the scene
// only touches a handful of DOM members, so plain fakes are used instead of
// pulling this file through jsdom.

// A deferred `Application.init` lets a test close the editor while the build is
// still awaiting, which is the race this suite exists to cover.
let pendingInit: { resolve: () => void } | null = null
const destroyCalls: unknown[][] = []

/**
 * Reads `pendingInit` through a call so TypeScript cannot narrow it away — only
 * the fake `Application.init` assigns it, which control-flow analysis can't see.
 */
function currentInit(): { resolve: () => void } | null {
  return pendingInit
}

function makeHost(): HTMLElement {
  return {
    appendChild: vi.fn(),
    clientWidth: 800,
    clientHeight: 400,
    isConnected: true
  } as unknown as HTMLElement
}

class FakeContainer {
  children: unknown[] = []
  addChild(c: unknown): void {
    this.children.push(c)
  }
}

class FakeApplication {
  canvas = {
    style: {} as Record<string, string>,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn()
  }
  stage = new FakeContainer()
  renderer = { screen: { width: 0, height: 0 }, resize: vi.fn() }
  render = vi.fn()
  async init(): Promise<void> {
    await new Promise<void>((resolve) => {
      pendingInit = { resolve }
    })
  }
  destroy(...args: unknown[]): void {
    destroyCalls.push(args)
  }
}

const loadPixi = vi.hoisted(() => vi.fn())
vi.mock('@/lib/timeline/pixiLoader', () => ({ loadPixi }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

function makeScene(): ReturnType<typeof useClipEditorScene> {
  // No component instance, so the composable skips its onBeforeUnmount hook and
  // the test drives mount/unmount directly — exactly how the dialog uses it.
  return useClipEditorScene({ onReady: vi.fn(), onResize: vi.fn() })
}

/** Let the mount() microtask chain advance to the next await. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('useClipEditorScene', () => {
  beforeEach(() => {
    pendingInit = null
    destroyCalls.length = 0
    vi.clearAllMocks()
    loadPixi.mockResolvedValue({
      Application: FakeApplication,
      Container: FakeContainer,
      Graphics: class {},
      Text: class {},
      Mesh: class {},
      MeshGeometry: class {},
      Texture: { WHITE: {} }
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    vi.stubGlobal('window', { devicePixelRatio: 1 })
  })

  it('builds the scene and reports ready', async () => {
    const scene = makeScene()
    const mounted = scene.mount(makeHost())
    await flush()
    currentInit()?.resolve()
    await mounted

    expect(scene.isReady.value).toBe(true)
    expect(scene.worldLayer.value).not.toBeNull()
    expect(scene.getCanvas()).not.toBeNull()
  })

  it('reopening after a close mid-build still builds a scene', async () => {
    // Regression: closing the editor while Pixi was still initialising used to
    // leave the orphaned app assigned internally, so every later mount() hit the
    // `if (app) return` guard and the Clip Editor stayed blank until restart.
    const scene = makeScene()

    const firstMount = scene.mount(makeHost())
    await flush()

    // Close while the first build is still awaiting `init`.
    scene.unmount()
    const abandonedInit = currentInit()
    pendingInit = null
    abandonedInit?.resolve()
    await firstMount

    // The abandoned app must be destroyed rather than left running, and must not
    // have been adopted as the live scene.
    expect(destroyCalls).toHaveLength(1)
    expect(scene.isReady.value).toBe(false)
    expect(scene.getCanvas()).toBeNull()

    // Reopening must produce a working scene.
    const secondMount = scene.mount(makeHost())
    await flush()
    expect(currentInit()).not.toBeNull()
    currentInit()?.resolve()
    await secondMount

    expect(scene.isReady.value).toBe(true)
    expect(scene.getCanvas()).not.toBeNull()
  })

  it('does not release shared global Pixi resources when discarding an abandoned build', async () => {
    // The clip editor shares Pixi's process-global batch pool and white-texture
    // singleton with the live timeline renderer, so a discarded build must use
    // the same narrow destroy options as unmount().
    const scene = makeScene()
    const mounted = scene.mount(makeHost())
    await flush()
    scene.unmount()
    currentInit()?.resolve()
    await mounted

    expect(destroyCalls[0]).toEqual([{ removeView: true }, { children: true, texture: false }])
  })
})
