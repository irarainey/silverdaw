import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useFxAutomation } from '@/lib/fx/useFxAutomation'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({ log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

function seedAutomatedTrack(): ReturnType<typeof useProjectStore> {
  const project = useProjectStore()
  project.tracks = [
    {
      id: 't1',
      name: 'T',
      colorIndex: 0,
      muted: false,
      soloed: false,
      volume: 1,
      clipIds: [],
      lengthMs: 1000,
      automation: { filter: [{ timeMs: 0, value: -1 }, { timeMs: 1000, value: 1 }] }
    } as never
  ]
  return project
}

describe('useFxAutomation.displayValue', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('returns the static value when the param is not automated', () => {
    const project = useProjectStore()
    project.tracks = [{ id: 't1', name: 'T', colorIndex: 0, muted: false, soloed: false, volume: 1, clipIds: [], lengthMs: 1000 } as never]
    const fx = useFxAutomation(ref('t1'))
    expect(fx.displayValue('filter', 0.3)).toBe(0.3)
  })

  it('samples the curve at the playhead when automated', () => {
    seedAutomatedTrack()
    const transport = useTransportStore()
    const fx = useFxAutomation(ref('t1'))
    transport.positionMs = 500 // midpoint of a -1 -> 1 ramp
    expect(fx.displayValue('filter', 0)).toBeCloseTo(0)
    transport.positionMs = 1000
    expect(fx.displayValue('filter', 0)).toBeCloseTo(1)
    transport.positionMs = 0
    expect(fx.displayValue('filter', 0)).toBeCloseTo(-1)
  })

  it('ignores the static value while automated (curve wins)', () => {
    seedAutomatedTrack()
    const transport = useTransportStore()
    const fx = useFxAutomation(ref('t1'))
    transport.positionMs = 1000
    // staticValue 0.123 is irrelevant — the curve value (1) is shown.
    expect(fx.displayValue('filter', 0.123)).toBeCloseTo(1)
  })

  it('returns the static value for a different, non-automated param', () => {
    seedAutomatedTrack()
    const fx = useFxAutomation(ref('t1'))
    expect(fx.displayValue('pan', -0.5)).toBe(-0.5)
  })
})
