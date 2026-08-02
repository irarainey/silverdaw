// Regression cover for the chop/paste/move fan-out.
//
// The backend seeds a clip's effective track gain itself — `handleClipAdd` passes it to
// `addClip` and `handleClipMove` re-applies it on a cross-track re-parent — so a follow-up
// TRACK_GAIN from the renderer is pure duplication. It is not free duplication: the backend
// answers TRACK_GAIN by re-applying the gain to EVERY clip on the track, which turns a bulk
// edit such as Chop to Grid into O(clips²) engine writes.

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { send } from '@/lib/bridgeService'
import { useProjectStore, type Clip } from '@/stores/projectStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

const sendMock = vi.mocked(send)

function sentTypes(): string[] {
  return sendMock.mock.calls.map((c) => c[0] as string)
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    libraryItemId: 'lib1',
    filePath: 'C:\\x.wav',
    fileName: 'x.wav',
    startMs: 0,
    inMs: 0,
    durationMs: 1000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    unresolved: false,
    ...overrides
  } as Clip
}

function makeTrack(id: string, clipIds: string[]) {
  return { id, name: `Track ${id}`, clipIds, volume: 0.5, lengthMs: 10_000 } as never
}

describe('clip edits do not re-push track gain', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'new-clip-id') })
  })

  it('sends no TRACK_GAIN when splitting a clip', () => {
    const project = useProjectStore()
    project.tracks = [makeTrack('t1', ['c1'])]
    project.clips = { c1: makeClip() }

    expect(project.splitClipAt('c1', 500)).toBe('new-clip-id')

    expect(sentTypes()).toContain('CLIP_ADD')
    expect(sentTypes()).not.toContain('TRACK_GAIN')
  })

  it('sends no TRACK_GAIN when duplicating a clip', () => {
    const project = useProjectStore()
    project.tracks = [makeTrack('t1', ['c1'])]
    project.clips = { c1: makeClip() }

    expect(project.duplicateClip('c1')).toBe('new-clip-id')

    expect(sentTypes()).toContain('CLIP_ADD')
    expect(sentTypes()).not.toContain('TRACK_GAIN')
  })

  it('sends no TRACK_GAIN when moving a clip to another track', () => {
    const project = useProjectStore()
    project.tracks = [makeTrack('t1', ['c1']), makeTrack('t2', [])]
    project.clips = { c1: makeClip() }

    project.moveClip('c1', 0, 't2')

    // The re-parent must still reach the backend, which applies the destination gain.
    expect(sendMock).toHaveBeenCalledWith(
      'CLIP_MOVE',
      expect.objectContaining({ clipId: 'c1', trackId: 't2' })
    )
    expect(sentTypes()).not.toContain('TRACK_GAIN')
  })

  it('still pushes every track gain on reconnect', () => {
    const project = useProjectStore()
    project.tracks = [makeTrack('t1', ['c1']), makeTrack('t2', [])]

    project.pushAllGains()

    expect(sentTypes()).toEqual(['TRACK_GAIN', 'TRACK_GAIN'])
  })
})
