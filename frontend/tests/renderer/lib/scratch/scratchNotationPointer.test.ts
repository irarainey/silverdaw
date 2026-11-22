import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createNotationPointerInteraction } from '@/lib/scratch/scratchNotationPointer'
import type { NotationSelection } from '@/lib/scratch/useScratchNotationEditor'

function createPointerInteraction() {
  const selection = ref<NotationSelection | null>(null)
  const callbacks = {
    onBeginEdit: vi.fn(),
    onEndEdit: vi.fn(),
    onSelect: vi.fn((lane: NotationSelection['lane'], index: number) => { selection.value = { lane, index } }),
    onMovePlatter: vi.fn(),
    onMoveCrossfader: vi.fn(),
    onAddPlatter: vi.fn(),
    onAddCrossfader: vi.fn(),
    onDelete: vi.fn()
  }
  const interaction = createNotationPointerInteraction(
    {
      svgEl: ref({
        focus: vi.fn(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 200 })
      } as unknown as SVGSVGElement),
      viewBoxWidth: ref(800),
      viewBoxHeight: ref(200),
      durationUs: ref(1_000_000),
      contentWidth: ref(752),
      paddingX: 24,
      platterLaneHeight: ref(126),
      platterMinTurns: ref(0),
      platterMaxTurns: ref(1),
      turnsMargin: 8,
      cfLaneTop: ref(138),
      cfLaneHeight: ref(54),
      crossfader: ref([0, 0.5, 0.55, 0.5, 1].map((value, i) =>
        ({ value, timeUs: i === 0 ? 0 : i === 4 ? 1_000_000 : 500_000 }))),
      selection
    },
    callbacks
  )
  return { callbacks, interaction }
}

describe('createNotationPointerInteraction', () => {
  it('cycles identical handles in stored order, drags just the chosen one and right-clicks without cycling', () => {
    const { callbacks, interaction } = createPointerInteraction()
    const event = { clientX: 400, clientY: 161, button: 0, pointerId: 1, preventDefault: vi.fn() } as unknown as PointerEvent
    interaction.handlePointDown('crossfader', 3, event)
    expect(callbacks.onSelect).toHaveBeenLastCalledWith('crossfader', 1)
    interaction.handlePointerUp(event)
    interaction.handlePointDown('crossfader', 3, event)
    interaction.handlePointerMove({ ...event, clientY: 138 })
    expect(callbacks.onMoveCrossfader).toHaveBeenLastCalledWith(3, 500_000, 1)
    interaction.finishDrag()
    interaction.handlePointerMove(event)
    expect(callbacks.onMoveCrossfader).toHaveBeenCalledTimes(1)
    interaction.handlePointContextMenu('crossfader', 3, { ...event, button: 2 })
    expect(callbacks.onDelete).toHaveBeenCalledWith('crossfader', 3)
    interaction.handlePointDown('crossfader', 3, { ...event, clientY: 159 })
    expect(callbacks.onSelect).toHaveBeenLastCalledWith('crossfader', 2)
  })
  it('selects and deletes the point from its context menu', () => {
    const { callbacks, interaction } = createPointerInteraction()
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent

    interaction.handlePointContextMenu('platter', 1, event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.onSelect).toHaveBeenCalledWith('platter', 1)
    expect(callbacks.onDelete).toHaveBeenCalledWith('platter', 1)
  })
})
