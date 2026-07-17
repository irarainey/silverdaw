import { describe, expect, it } from 'vitest'
import { createScratchPlatterHoldController } from '@/lib/scratch/scratchPlatterHold'

describe('createScratchPlatterHoldController', () => {
  it('toggles the virtual platter hold', () => {
    const controller = createScratchPlatterHoldController()

    controller.toggle()
    expect(controller.isHeld.value).toBe(true)

    controller.toggle()
    expect(controller.isHeld.value).toBe(false)
  })

  it('releases a held platter on external cancellation', () => {
    const controller = createScratchPlatterHoldController()
    controller.toggle()

    controller.release()
    expect(controller.isHeld.value).toBe(false)
  })
})
