import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore, type Clip } from './projectStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audio', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

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

describe('projectStore — clip lock guards', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('trimClip is rejected when locked, accepted after unlock', () => {
    const project = useProjectStore()
    project.tracks = [
      { id: 't1', name: 'T', colorIndex: 0, muted: false, solo: false, volume: 1, pan: 0, armed: false, clipIds: ['c1'], lengthMs: 1000 } as never
    ]
    project.clips = { c1: makeClip({ locked: true }) }

    project.trimClip('c1', 100, 100, 800)
    expect(project.clips.c1.startMs).toBe(0)
    expect(project.clips.c1.inMs).toBe(0)
    expect(project.clips.c1.durationMs).toBe(1000)

    project.setClipLocked('c1', false)
    expect(project.clips.c1.locked).toBeUndefined()

    project.trimClip('c1', 100, 100, 800)
    expect(project.clips.c1.startMs).toBe(100)
    expect(project.clips.c1.inMs).toBe(100)
    expect(project.clips.c1.durationMs).toBe(800)
  })

  it('moveClip is rejected when locked, accepted after unlock', () => {
    const project = useProjectStore()
    project.tracks = [
      { id: 't1', name: 'T', colorIndex: 0, muted: false, solo: false, volume: 1, pan: 0, armed: false, clipIds: ['c1'], lengthMs: 1000 } as never
    ]
    project.clips = { c1: makeClip({ locked: true }) }

    project.moveClip('c1', 500)
    expect(project.clips.c1.startMs).toBe(0)

    project.setClipLocked('c1', false)
    project.moveClip('c1', 500)
    expect(project.clips.c1.startMs).toBe(500)
  })
})
