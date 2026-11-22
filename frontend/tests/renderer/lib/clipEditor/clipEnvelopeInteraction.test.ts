import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClipEnvelopeInteraction } from '@/lib/clipEditor/clipEnvelopeInteraction'
import { useClipEditorVolumeShapeDraft } from '@/lib/clipEditor/useClipEditorVolumeShapeDraft'

function setup() {
  const events = new EventTarget()
  vi.stubGlobal('window', events)
  const draft = useClipEditorVolumeShapeDraft()
  for (let i = 0; i < 3; i++) draft.addPoint(500, 1)
  const handlers = createClipEnvelopeInteraction({
    volumeShapeDraft: draft, viewInMs: () => 0, volumeShapeDurationMs: () => 1000,
    volumeEditActive: () => true, draftEffectiveRatio: () => 1,
    sourceBeatGrid: () => null, waveformStereoLanes: ref(false)
  })
  const key = (key: string, options: Partial<KeyboardEvent> = {}) => {
    const preventDefault = vi.fn()
    handlers.onEnvelopeKeydown({ key, preventDefault, stopPropagation: vi.fn(), ...options } as unknown as KeyboardEvent)
    return preventDefault
  }
  const rect = { left: 0, top: 0, height: 138, width: 100 } as DOMRect
  const down = () => handlers.onEnvelopePointerDown({
    clientX: 51, clientY: 40, button: 0, preventDefault: vi.fn(),
    currentTarget: { focus: handlers.onEnvelopeFocus }
  } as unknown as MouseEvent, rect, 0, 1000)
  const move = (x: number, y: number) =>
    events.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: x, clientY: y }))
  const up = () => events.dispatchEvent(new Event('mouseup'))
  return { ...handlers, draft, key, down, move, up }
}

afterEach(() => vi.unstubAllGlobals())

describe('clip envelope focus and gestures', () => {
  it('tabs through identical handles and nudges one without stealing unfocused arrows or Tab at the edge', () => {
    const h = setup()
    expect(h.key('ArrowDown')).not.toHaveBeenCalled()
    h.onEnvelopeFocus()
    expect(h.key('Tab', { shiftKey: true })).not.toHaveBeenCalled()
    h.key('Tab')
    h.key('Tab')
    h.key('ArrowRight', { altKey: true })
    h.key('ArrowDown', { shiftKey: true })
    expect(h.draft.selectedIndex.value).toBe(3)
    expect(h.draft.draftPoints.value.slice(1, 4)).toEqual([
      { timeMs: 500, gain: 1 }, { timeMs: 500, gain: 1 }, { timeMs: 501, gain: expect.closeTo(10 ** (-0.1 / 20), 8) }
    ])
    h.clearEnvelopeFocus()
    expect(h.draft.selectedIndex.value).toBeNull()
    expect(h.key('ArrowLeft')).not.toHaveBeenCalled()
  })

  it('nudges quiet points in decibels without muting them and can raise a point from silence', () => {
    const h = setup()
    h.onEnvelopeFocus()
    h.draft.movePoint(0, 0, 0.01) // -40 dB
    const gain = () => h.draft.draftPoints.value[0]!.gain
    h.key('ArrowDown')
    expect(20 * Math.log10(gain())).toBeCloseTo(-41)
    h.key('ArrowUp')
    expect(gain()).toBeCloseTo(0.01, 8)
    h.draft.movePoint(0, 0, 0)
    h.key('ArrowUp', { shiftKey: true })
    expect(20 * Math.log10(gain())).toBeCloseTo(-59.9)
    h.key('ArrowDown', { shiftKey: true })
    expect(gain()).toBe(0)
  })

  it('cycles coincident handles on click but drags the chosen one without jumping to the grab location', () => {
    const h = setup()
    for (const index of [1, 2, 3, 1, 2]) {
      h.down()
      h.up()
      expect(h.draft.selectedIndex.value).toBe(index)
    }
    h.down()
    h.move(41, 40)
    expect(h.draft.draftPoints.value[1]).toEqual({ timeMs: 400, gain: 1 })
    expect(h.draft.selectedIndex.value).toBe(1)
    h.key('ArrowLeft')
    h.move(20, 40)
    h.up()
    expect(h.draft.draftPoints.value[1]).toEqual({ timeMs: 395, gain: 1 })
  })

  it('leaves no stale drag after blur or draft replacement', () => {
    const h = setup()
    h.down()
    h.clearEnvelopeFocus()
    h.move(20, 40)
    h.up()
    expect(h.draft.draftPoints.value[1]).toEqual({ timeMs: 500, gain: 1 })
    h.down()
    h.draft.reset(300)
    h.move(20, 40)
    h.up()
    expect(h.draft.selectedIndex.value).toBeNull()
    expect(h.draft.committedPoints()).toEqual([])
  })
})
