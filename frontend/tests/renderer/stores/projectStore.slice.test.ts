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

describe('projectStore — sliceClipToTimeline', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('cuts a clip into adjacent clips at every interior marker (one undo group)', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.clips = { c1: makeClip() }

    const made = project.sliceClipToTimeline('c1', [250, 500, 750])
    expect(made).toBe(3)

    const track = project.tracks[0]!
    expect(track.clipIds).toHaveLength(4)

    // Every resulting slice is a contiguous 250 ms window of the source.
    const windows = track.clipIds
      .map((id) => project.clips[id]!)
      .map((c) => [c.startMs, c.inMs, c.durationMs])
    expect(windows).toEqual([
      [0, 0, 250],
      [250, 250, 250],
      [500, 500, 250],
      [750, 750, 250]
    ])

    // The whole chop is bracketed by a single "Slice clip" undo group.
    const begins = sendMock.mock.calls.filter(([t]) => t === 'EDIT_GROUP_BEGIN')
    expect(begins.some(([, p]) => (p as { label: string }).label === 'Slice clip')).toBe(true)
  })

  it('ignores markers outside the clip interior', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.clips = { c1: makeClip() }

    // -100 and 1500 are out of range; only 500 is a valid interior cut.
    const made = project.sliceClipToTimeline('c1', [-100, 500, 1500])
    expect(made).toBe(1)
    expect(project.tracks[0]!.clipIds).toHaveLength(2)
  })

  it('maps markers through the tempo ratio on a warped clip', () => {
    const project = useProjectStore()
    seedTrack(project)
    // ratio 2 → 1000 ms of source plays back over 500 ms of timeline.
    project.clips = {
      c1: makeClip({ warpEnabled: true, tempoRatio: 2, effectiveTempoRatio: 2, effectiveWarpActive: true })
    }

    // Source marker 500 ms → timeline 250 ms; one interior cut.
    const made = project.sliceClipToTimeline('c1', [500])
    expect(made).toBe(1)
    const left = project.clips.c1!
    expect(left.inMs).toBe(0)
    expect(left.durationMs).toBe(500) // source-time length of the left half
  })

  it('does nothing when there are no interior markers', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.clips = { c1: makeClip() }
    expect(project.sliceClipToTimeline('c1', [])).toBe(0)
    expect(project.tracks[0]!.clipIds).toHaveLength(1)
  })
})

describe('projectStore — sliceClipToSamples', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('emits one batch envelope of contiguous source windows (head + tail included)', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.clips = { c1: makeClip() }

    const n = project.sliceClipToSamples('c1', [250, 500, 750])
    expect(n).toBe(4)

    const call = sendMock.mock.calls.find(([t]) => t === 'CLIP_SLICE_TO_SAMPLES')
    expect(call).toBeDefined()
    const payload = call![1] as {
      clipId: string
      audioType: string
      slices: { inMs: number; durationMs: number }[]
    }
    expect(payload.clipId).toBe('c1')
    expect(payload.audioType).toBe('simple')
    expect(payload.slices.map((s) => [s.inMs, s.durationMs])).toEqual([
      [0, 250],
      [250, 250],
      [500, 250],
      [750, 250]
    ])
  })

  it('ignores out-of-range markers', () => {
    const project = useProjectStore()
    seedTrack(project)
    project.clips = { c1: makeClip() }
    // Only 500 is interior → two windows.
    expect(project.sliceClipToSamples('c1', [-50, 500, 2000])).toBe(2)
  })
})
