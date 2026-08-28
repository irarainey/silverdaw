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

describe('projectStore — setClipBeatOffset', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('applies the phase optimistically and emits CLIP_SET_BEAT_OFFSET', () => {
    const project = useProjectStore()
    project.clips = { c1: makeClip() }
    const revision = project.timelineRevision

    project.setClipBeatOffset('c1', 120)

    expect(project.clips.c1!.beatOffsetMs).toBe(120)
    expect(project.timelineRevision).toBeGreaterThan(revision)
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_BEAT_OFFSET', {
      clipId: 'c1',
      beatOffsetMs: 120
    })
  })

  it('is a no-op when the phase is unchanged', () => {
    const project = useProjectStore()
    project.clips = { c1: makeClip({ beatOffsetMs: 120 }) }

    project.setClipBeatOffset('c1', 120)
    expect(sendMock).not.toHaveBeenCalled()
  })

  // Absent is the unshifted source grid, so zero must clear rather than store a 0 that
  // would then be written into every project file.
  it('clears back to undefined at zero', () => {
    const project = useProjectStore()
    project.clips = { c1: makeClip({ beatOffsetMs: 120 }) }

    project.setClipBeatOffset('c1', 0)

    expect(project.clips.c1!.beatOffsetMs).toBeUndefined()
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_BEAT_OFFSET', {
      clipId: 'c1',
      beatOffsetMs: 0
    })
  })

  it('treats an absent offset as zero', () => {
    const project = useProjectStore()
    project.clips = { c1: makeClip() }

    project.setClipBeatOffset('c1', 0)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('only ever touches the clip it was given', () => {
    const project = useProjectStore()
    project.clips = { c1: makeClip(), c2: makeClip({ id: 'c2' }) }

    project.setClipBeatOffset('c1', 90)

    expect(project.clips.c2!.beatOffsetMs).toBeUndefined()
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('ignores unknown clips and non-finite offsets', () => {
    const project = useProjectStore()
    project.clips = { c1: makeClip() }

    project.setClipBeatOffset('missing', 90)
    project.setClipBeatOffset('c1', Number.NaN)

    expect(sendMock).not.toHaveBeenCalled()
  })
})
