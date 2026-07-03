import { describe, expect, it } from 'vitest'
import {
  beginStemSeparation,
  applyStemProgress,
  clearStemSeparationState,
  markStemSeparationFinalizing,
  snapshotStemSeparationState,
  useStemSeparationState
} from '@/lib/stemSeparationState'

describe('stemSeparationState', () => {
  it('starts idle', () => {
    clearStemSeparationState()
    expect(snapshotStemSeparationState()).toBeNull()
    expect(useStemSeparationState().value).toBeNull()
  })

  it('tracks a job from begin through progress', () => {
    beginStemSeparation('j1', { sourceItemId: 's1', sourceName: 'Loop', clipId: 'c1' }, ['vocals', 'drums'])
    expect(snapshotStemSeparationState()).toEqual({
      jobId: 'j1',
      target: { sourceItemId: 's1', sourceName: 'Loop', clipId: 'c1' },
      stems: ['vocals', 'drums'],
      percent: 0,
      stage: 'prepare'
    })

    applyStemProgress({ jobId: 'j1', clipId: 'c1', stage: 'separate', percent: 40 })
    expect(snapshotStemSeparationState()).toMatchObject({ percent: 40, stage: 'separate' })
    clearStemSeparationState()
  })

  it('carries the per-stem detail label through progress', () => {
    beginStemSeparation('j1', { sourceItemId: 's1', sourceName: 'Loop', clipId: 'c1' }, ['drums'])
    applyStemProgress({ jobId: 'j1', clipId: 'c1', stage: 'separate', percent: 30, detail: 'drums' })
    expect(snapshotStemSeparationState()).toMatchObject({ stage: 'separate', detail: 'drums' })
    clearStemSeparationState()
  })

  it('never lets percent go backwards', () => {
    beginStemSeparation('j1', { sourceItemId: 's1', sourceName: 'Loop', clipId: 'c1' }, ['vocals'])
    applyStemProgress({ jobId: 'j1', clipId: 'c1', stage: 'separate', percent: 60 })
    applyStemProgress({ jobId: 'j1', clipId: 'c1', stage: 'separate', percent: 25 })
    expect(snapshotStemSeparationState()?.percent).toBe(60)
    clearStemSeparationState()
  })

  it('ignores progress when idle', () => {
    clearStemSeparationState()
    applyStemProgress({ jobId: 'j1', clipId: 'c1', stage: 'separate', percent: 50 })
    expect(snapshotStemSeparationState()).toBeNull()
  })

  it('ignores progress from a stale (different) job', () => {
    beginStemSeparation('j2', { sourceItemId: 's2', sourceName: 'Other' }, ['bass'])
    applyStemProgress({ jobId: 'j1', clipId: 'c1', stage: 'write', percent: 99 })
    expect(snapshotStemSeparationState()).toMatchObject({ jobId: 'j2', percent: 0, stage: 'prepare' })
    clearStemSeparationState()
  })

  it('marks the tracked job finalising at 100% on the write stage', () => {
    beginStemSeparation('j1', { sourceItemId: 's1', sourceName: 'Loop', clipId: 'c1' }, ['vocals'])
    applyStemProgress({ jobId: 'j1', clipId: 'c1', stage: 'separate', percent: 55, detail: 'vocals' })
    markStemSeparationFinalizing('j1')
    expect(snapshotStemSeparationState()).toMatchObject({ percent: 100, stage: 'write' })
    expect(snapshotStemSeparationState()?.detail).toBeUndefined()
    clearStemSeparationState()
  })

  it('does not finalise a stale (different) job', () => {
    beginStemSeparation('j2', { sourceItemId: 's2', sourceName: 'Other' }, ['bass'])
    markStemSeparationFinalizing('j1')
    expect(snapshotStemSeparationState()).toMatchObject({ jobId: 'j2', percent: 0, stage: 'prepare' })
    clearStemSeparationState()
  })
})
