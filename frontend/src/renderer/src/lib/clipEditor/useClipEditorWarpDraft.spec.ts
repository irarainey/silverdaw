import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import {
  currentHasTempoWarp,
  pitchNeedsProcessor,
  useClipEditorWarpDraft
} from './useClipEditorWarpDraft'
import { useTransportStore } from '@/stores/transportStore'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audio', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

describe('pitchNeedsProcessor', () => {
  it('returns true when semitones or cents are non-zero', () => {
    expect(pitchNeedsProcessor(0, 0)).toBe(false)
    expect(pitchNeedsProcessor(undefined, undefined)).toBe(false)
    expect(pitchNeedsProcessor(1, 0)).toBe(true)
    expect(pitchNeedsProcessor(0, 50)).toBe(true)
    expect(pitchNeedsProcessor(-2, -10)).toBe(true)
  })
})

describe('currentHasTempoWarp', () => {
  it('returns false when warp is disabled', () => {
    expect(currentHasTempoWarp({ warpEnabled: false })).toBe(false)
    expect(currentHasTempoWarp({})).toBe(false)
  })

  it('returns true for warp+tempo settings', () => {
    expect(currentHasTempoWarp({ warpEnabled: true, tempoRatio: 1.5 })).toBe(true)
  })

  it('returns false for a pitch-only Rubber Band activation (tempoRatio === 1 and pitch shifted)', () => {
    expect(
      currentHasTempoWarp({ warpEnabled: true, tempoRatio: 1, semitones: 2 })
    ).toBe(false)
  })

  it('still reports true when warp is on with pitch shift but no explicit tempoRatio pin', () => {
    expect(currentHasTempoWarp({ warpEnabled: true, semitones: 2 })).toBe(true)
  })
})

describe('useClipEditorWarpDraft', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('seeds default values when initialised on a source-library target', () => {
    const sourceBpm = computed<number | undefined>(() => 120)
    const draft = useClipEditorWarpDraft(sourceBpm)
    useTransportStore().setBpm(100)

    draft.initialise(null, false)

    expect(draft.draftTempoEnabled.value).toBe(false)
    expect(draft.draftMode.value).toBe('rhythmic')
    expect(draft.draftTempoPinned.value).toBe(false)
    expect(draft.draftPinnedBpm.value).toBeCloseTo(100, 2)
    expect(draft.draftSemitones.value).toBe(0)
    expect(draft.draftCents.value).toBe(0)
  })

  it('seeds draft from an existing-clip target preserving its warp/pitch state', () => {
    const sourceBpm = computed<number | undefined>(() => 100)
    const draft = useClipEditorWarpDraft(sourceBpm)

    draft.initialise(
      {
        warpEnabled: true,
        warpMode: 'tonal',
        tempoRatio: 1.5,
        semitones: 2,
        cents: 10
      } as never,
      true
    )

    expect(draft.draftTempoEnabled.value).toBe(true)
    expect(draft.draftMode.value).toBe('tonal')
    expect(draft.draftTempoPinned.value).toBe(true)
    expect(draft.draftPinnedBpm.value).toBeCloseTo(150, 2)
    expect(draft.draftSemitones.value).toBe(2)
    expect(draft.draftCents.value).toBe(10)
  })

  it('exposes effective ratio + bpm that react to slider changes', () => {
    const sourceBpm = computed<number | undefined>(() => 100)
    const draft = useClipEditorWarpDraft(sourceBpm)
    useTransportStore().setBpm(120)

    draft.initialise(null, false)
    expect(draft.draftEffectiveRatio.value).toBe(1)
    expect(draft.draftEffectiveBpm.value).toBe(100)
    expect(draft.draftTempoWarpActive.value).toBe(false)

    draft.draftTempoEnabled.value = true
    draft.draftTempoPinned.value = true
    draft.draftPinnedBpm.value = 150

    expect(draft.draftEffectiveRatio.value).toBeCloseTo(1.5, 3)
    expect(draft.draftEffectiveBpm.value).toBeCloseTo(150, 2)
    expect(draft.draftTempoWarpActive.value).toBe(true)
  })

  it('previewTempoRatio() returns undefined when neither warp nor pitch is active', () => {
    const sourceBpm = computed<number | undefined>(() => 100)
    const draft = useClipEditorWarpDraft(sourceBpm)
    draft.initialise(null, false)
    expect(draft.previewTempoRatio()).toBeUndefined()
  })

  it('previewTempoRatio() returns 1 for pitch-only drafts (Rubber Band needed but no stretch)', () => {
    const sourceBpm = computed<number | undefined>(() => 100)
    const draft = useClipEditorWarpDraft(sourceBpm)
    draft.initialise(null, false)
    draft.draftSemitones.value = 2
    expect(draft.previewTempoRatio()).toBe(1)
  })

  it('previewTempoRatio() returns the effective ratio when tempo is pinned', () => {
    const sourceBpm = computed<number | undefined>(() => 100)
    const draft = useClipEditorWarpDraft(sourceBpm)
    draft.initialise(null, false)
    draft.draftTempoEnabled.value = true
    draft.draftTempoPinned.value = true
    draft.draftPinnedBpm.value = 200
    expect(draft.previewTempoRatio()).toBeCloseTo(2, 3)
  })

  it('followProjectBpm/pinTempo flip the pinned flag without losing the BPM value', () => {
    const sourceBpm = computed<number | undefined>(() => 100)
    const draft = useClipEditorWarpDraft(sourceBpm)
    useTransportStore().setBpm(120)
    draft.initialise(null, false)
    draft.pinTempo()
    expect(draft.draftTempoPinned.value).toBe(true)
    expect(draft.draftPinnedBpm.value).toBeCloseTo(120, 2)
    draft.followProjectBpm()
    expect(draft.draftTempoPinned.value).toBe(false)
  })

  it('applyKeyPreset stamps semitones and resets cents', () => {
    const sourceBpm = computed<number | undefined>(() => 100)
    const draft = useClipEditorWarpDraft(sourceBpm)
    draft.draftCents.value = 30
    draft.applyKeyPreset(-3)
    expect(draft.draftSemitones.value).toBe(-3)
    expect(draft.draftCents.value).toBe(0)
  })

  it('draftProcessorEnabled covers warp OR pitch activation', () => {
    const sourceBpm = computed<number | undefined>(() => 100)
    const draft = useClipEditorWarpDraft(sourceBpm)
    draft.initialise(null, false)
    expect(draft.draftProcessorEnabled.value).toBe(false)
    draft.draftSemitones.value = 1
    expect(draft.draftProcessorEnabled.value).toBe(true)
    draft.draftSemitones.value = 0
    draft.draftTempoEnabled.value = true
    expect(draft.draftProcessorEnabled.value).toBe(true)
  })
})
