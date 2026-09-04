// A committed recording must never bury what is already on a track (ADR 0030).

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { releaseRecordingTrack, resolveRecordingTrackId } from '@/lib/recording/recordingPlacement'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

function makeTrack(id: string, clipIds: string[]): never {
  return { id, name: `Track ${id}`, clipIds, volume: 1, lengthMs: 10_000 } as never
}

describe('resolveRecordingTrackId', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('uses the selected track when it is empty, and scrolls it into view', () => {
    const project = useProjectStore()
    project.tracks = [makeTrack('t1', [])]
    project.selectedTrackId = 't1'

    expect(resolveRecordingTrackId()).toEqual({ trackId: 't1', created: false })
    expect(project.tracks).toHaveLength(1)
    expect(useUiStore().timelineRevealTrackRequest?.trackId).toBe('t1')
  })

  it('adds a track of its own when the selected track already has clips', () => {
    const project = useProjectStore()
    project.tracks = [makeTrack('t1', ['c1'])]
    project.selectedTrackId = 't1'

    const destination = resolveRecordingTrackId()
    expect(destination.created).toBe(true)
    expect(destination.trackId).not.toBe('t1')
    expect(project.tracks.map((track) => track.id)).toEqual(['t1', destination.trackId])
    expect(useUiStore().timelineRevealTrackRequest?.trackId).toBe(destination.trackId)
  })

  it('adds a track when nothing is selected', () => {
    const project = useProjectStore()
    project.tracks = [makeTrack('t1', ['c1'])]
    project.selectedTrackId = null

    const destination = resolveRecordingTrackId()
    expect(project.tracks.map((track) => track.id)).toEqual(['t1', destination.trackId])
  })

  it('releases only a track it created, and only while it is still empty', () => {
    const project = useProjectStore()
    project.tracks = [makeTrack('t1', ['c1'])]
    project.selectedTrackId = 't1'

    const destination = resolveRecordingTrackId()
    releaseRecordingTrack(destination)
    expect(project.tracks.map((track) => track.id)).toEqual(['t1'])

    // A track the recording did not create is never removed.
    releaseRecordingTrack({ trackId: 't1', created: false })
    expect(project.tracks).toHaveLength(1)
  })
})
