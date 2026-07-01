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

describe('projectStore — setClipBrake', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('toggles the flag and emits CLIP_SET_BRAKE only on change', () => {
    const project = useProjectStore()
    project.clips = { c1: makeClip() }

    project.setClipBrake('c1', true)
    expect(project.clips.c1!.brake).toBe(true)
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_BRAKE', { clipId: 'c1', on: true })

    // No-op when already on — no duplicate command to the backend.
    sendMock.mockClear()
    project.setClipBrake('c1', true)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('clears the flag back to undefined when turned off', () => {
    const project = useProjectStore()
    project.clips = { c1: makeClip({ brake: true }) }

    project.setClipBrake('c1', false)
    expect(project.clips.c1!.brake).toBeUndefined()
    expect(sendMock).toHaveBeenCalledWith('CLIP_SET_BRAKE', { clipId: 'c1', on: false })
  })

  it('ignores unknown clip ids', () => {
    const project = useProjectStore()
    project.clips = {}
    project.setClipBrake('missing', true)
    expect(sendMock).not.toHaveBeenCalled()
  })
})
