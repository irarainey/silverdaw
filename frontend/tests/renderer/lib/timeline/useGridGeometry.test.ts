import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_PX_PER_SECOND, MIN_PX_PER_SECOND } from '@/lib/timeline/constants'
import { useGridGeometry } from '@/lib/timeline/useGridGeometry'

describe('useGridGeometry — setPxPerSecond', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('applies in-range requests exactly so steps and presets round-trip', () => {
    const geometry = useGridGeometry()
    expect(geometry.setPxPerSecond(90)).toBe(90)
    // Fine-step values just above the coarse step must survive verbatim.
    expect(geometry.setPxPerSecond(11)).toBe(11)
    expect(geometry.pxPerSecond.value).toBe(11)
  })

  it('keeps sub-coarse-step requests unrounded so zoom-to-fit lands exactly', () => {
    const geometry = useGridGeometry()
    expect(geometry.setPxPerSecond(3.2667)).toBeCloseTo(3.2667, 4)
  })

  it('clamps to the supported zoom range', () => {
    const geometry = useGridGeometry()
    expect(geometry.setPxPerSecond(0.01)).toBe(MIN_PX_PER_SECOND)
    expect(geometry.setPxPerSecond(5000)).toBe(MAX_PX_PER_SECOND)
    expect(geometry.setPxPerSecond(0)).toBe(MIN_PX_PER_SECOND)
  })
})
