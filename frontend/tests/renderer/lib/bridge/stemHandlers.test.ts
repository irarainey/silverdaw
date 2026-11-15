import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stemBridgeHandlers } from '@/lib/bridge/handlers/stemHandlers'
import {
  beginStemSeparation,
  clearStemSeparationState,
  snapshotStemSeparationState
} from '@/lib/stemSeparationState'

const { forgetStemJob, pushInfo, pushError } = vi.hoisted(() => ({
  forgetStemJob: vi.fn(),
  pushInfo: vi.fn(),
  pushError: vi.fn()
}))

vi.mock('@/lib/stems/createStemTracks', () => ({
  createTracksFromStems: vi.fn(),
  createTrackFromStem: vi.fn(),
  forgetStemJob
}))
vi.mock('@/stores/notificationsStore', () => ({
  useNotificationsStore: () => ({ pushInfo, pushError })
}))
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), error: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  clearStemSeparationState()
})

describe('stem failure handler', () => {
  it.each(['cancelled', 'inference'] as const)('forgets a %s job', (code) => {
    beginStemSeparation('job-1', { sourceItemId: 'item-1', sourceName: 'Song' }, ['vocals'])

    stemBridgeHandlers.STEM_FAILED({ jobId: 'job-1', code, error: 'Stopped' })

    expect(forgetStemJob).toHaveBeenCalledExactlyOnceWith('job-1')
    expect(snapshotStemSeparationState()).toBeNull()
    if (code === 'cancelled') expect(pushInfo).toHaveBeenCalledWith('Stem separation cancelled')
    else expect(pushError).toHaveBeenCalledWith('Stem separation failed: Stopped')
  })

  it('cleans up a stale failure without clearing a newer active job', () => {
    beginStemSeparation('job-new', { sourceItemId: 'item-1', sourceName: 'Song' }, ['vocals'])

    stemBridgeHandlers.STEM_FAILED({
      jobId: 'job-old',
      code: 'cancelled',
      error: 'Cancelled'
    })

    expect(forgetStemJob).toHaveBeenCalledExactlyOnceWith('job-old')
    expect(snapshotStemSeparationState()?.jobId).toBe('job-new')
    expect(pushInfo).not.toHaveBeenCalled()
    expect(pushError).not.toHaveBeenCalled()
  })
})
