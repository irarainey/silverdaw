import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createNotationPointerInteraction } from '@/lib/scratch/scratchNotationPointer'

function createPointerInteraction() {
  const callbacks = {
    onBeginEdit: vi.fn(),
    onEndEdit: vi.fn(),
    onSelect: vi.fn(),
    onMovePlatter: vi.fn(),
    onMoveCrossfader: vi.fn(),
    onAddPlatter: vi.fn(),
    onAddCrossfader: vi.fn(),
    onDelete: vi.fn()
  }
  const interaction = createNotationPointerInteraction(
    {
      svgEl: ref(null),
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
      cfLaneHeight: ref(54)
    },
    callbacks
  )
  return { callbacks, interaction }
}

describe('createNotationPointerInteraction', () => {
  it('selects and deletes the point from its context menu', () => {
    const { callbacks, interaction } = createPointerInteraction()
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent

    interaction.handlePointContextMenu('platter', 1, event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.onSelect).toHaveBeenCalledWith('platter', 1)
    expect(callbacks.onDelete).toHaveBeenCalledWith('platter', 1)
  })
})
