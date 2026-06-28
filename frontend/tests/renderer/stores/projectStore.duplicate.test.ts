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

function seedTrack(project: ReturnType<typeof useProjectStore>): void {
  project.tracks = [
    {
      id: 't1',
      name: 'T',
      colorIndex: 0,
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      armed: false,
      clipIds: ['c1'],
      lengthMs: 1000
    } as never
  ]
}

describe('projectStore — duplicateClip carries clip settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('copies the volume envelope onto the duplicate and replays it to the backend', () => {
    const project = useProjectStore()
    seedTrack(project)
    const envelope = [
      { timeMs: 0, gain: 0 },
      { timeMs: 1000, gain: 1 }
    ]
    project.clips = { c1: makeClip({ envelopePoints: envelope }) }

    const newId = project.duplicateClip('c1')
    expect(newId).not.toBeNull()

    const copy = project.clips[newId!]!
    expect(copy.envelopePoints).toEqual(envelope)
    // The duplicate owns its own envelope array (no aliasing with the source).
    expect(copy.envelopePoints).not.toBe(project.clips.c1!.envelopePoints)

    const envelopeSend = sendMock.mock.calls.find(([type]) => type === 'CLIP_SET_ENVELOPE')
    expect(envelopeSend).toBeDefined()
    expect(envelopeSend![1]).toMatchObject({ clipId: newId, points: envelope })
  })

  it('does not emit CLIP_SET_ENVELOPE when the source has no volume shape', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.clips = { c1: makeClip() }

    const newId = project.duplicateClip('c1')
    expect(newId).not.toBeNull()
    expect(project.clips[newId!]!.envelopePoints).toBeUndefined()
    expect(sendMock.mock.calls.some(([type]) => type === 'CLIP_SET_ENVELOPE')).toBe(false)
  })

  it('carries lock state and replays CLIP_SET_LOCKED for a locked source', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.clips = { c1: makeClip({ locked: true }) }

    const newId = project.duplicateClip('c1')
    expect(newId).not.toBeNull()
    expect(project.clips[newId!]!.locked).toBe(true)
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_LOCKED', { clipId: newId, locked: true })
  })

  it('carries effective timing so a warped duplicate renders at the source footprint', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.clips = {
      c1: makeClip({
        warpEnabled: true,
        tempoRatio: 2,
        effectiveDurationMs: 500,
        effectiveTempoRatio: 2,
        effectiveWarpActive: true
      })
    }

    const newId = project.duplicateClip('c1')
    expect(newId).not.toBeNull()
    const copy = project.clips[newId!]!
    expect(copy.effectiveDurationMs).toBe(500)
    expect(copy.effectiveTempoRatio).toBe(2)
    expect(copy.effectiveWarpActive).toBe(true)
  })
})
