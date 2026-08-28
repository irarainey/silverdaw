// Split must hand the source clip's per-clip playback state to the correct half.
//
// `duplicateClip` has always replayed reverse / envelope / lock onto its copy; `splitClipAt`
// replayed only name and warp, so a split silently dropped reverse, the turntable effects and
// the volume shape. Reverse also needs mirrored trim math: it plays the clip's source window
// backwards, so the timeline-LEFT half is the TAIL of that window.

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

function payloadFor(type: string, clipId: string): Record<string, unknown> | undefined {
  const call = sendMock.mock.calls.find(
    (c) => c[0] === type && (c[1] as { clipId?: string })?.clipId === clipId
  )
  return call?.[1] as Record<string, unknown> | undefined
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    libraryItemId: 'lib1',
    filePath: 'C:\\x.wav',
    fileName: 'x.wav',
    startMs: 0,
    inMs: 1000,
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

function setup(clip: Clip) {
  const project = useProjectStore()
  project.tracks = [makeTrack('t1', ['c1'])]
  project.clips = { c1: clip }
  return project
}

describe('splitClipAt carries per-clip playback state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'right') })
  })

  it('maps a forward clip head-then-tail', () => {
    const project = setup(makeClip())

    project.splitClipAt('c1', 400)

    expect(payloadFor('CLIP_TRIM', 'c1')).toMatchObject({ inMs: 1000, durationMs: 400 })
    expect(payloadFor('CLIP_ADD', 'right')).toMatchObject({ inMs: 1400, durationMs: 600 })
  })

  it('mirrors the source window for a reversed clip', () => {
    const project = setup(makeClip({ reversed: true }))

    project.splitClipAt('c1', 400)

    // Reversed playback starts at the window's end, so the first 400 ms of timeline is
    // the window's LAST 400 ms, and the right half is its head.
    expect(payloadFor('CLIP_TRIM', 'c1')).toMatchObject({ inMs: 1600, durationMs: 400 })
    expect(payloadFor('CLIP_ADD', 'right')).toMatchObject({ inMs: 1000, durationMs: 600 })
  })

  it('replays reverse onto the right half', () => {
    const project = setup(makeClip({ reversed: true }))

    project.splitClipAt('c1', 400)

    expect(payloadFor('CLIP_SET_REVERSED', 'right')).toMatchObject({ reversed: true })
    expect(project.clips.right?.reversed).toBe(true)
  })

  it('leaves a forward clip unreversed', () => {
    const project = setup(makeClip())

    project.splitClipAt('c1', 400)

    expect(payloadFor('CLIP_SET_REVERSED', 'right')).toBeUndefined()
  })

  // Each half is independently editable afterwards, but the split itself must be
  // invisible on the beat markers, so the right half inherits the parent's phase.
  it('inherits the beat-grid phase onto the right half', () => {
    const project = setup(makeClip({ beatOffsetMs: 120 }))

    project.splitClipAt('c1', 400)

    expect(project.clips.right?.beatOffsetMs).toBe(120)
    expect(payloadFor('CLIP_SET_BEAT_OFFSET', 'right')).toMatchObject({ beatOffsetMs: 120 })
  })

  it('sends no phase for a clip on the unshifted source grid', () => {
    const project = setup(makeClip())

    project.splitClipAt('c1', 400)

    expect(payloadFor('CLIP_SET_BEAT_OFFSET', 'right')).toBeUndefined()
  })

  it('hands an end-of-clip brake to the right half only', () => {
    const project = setup(makeClip({ brake: true }))

    project.splitClipAt('c1', 400)

    expect(payloadFor('CLIP_SET_BRAKE', 'c1')).toMatchObject({ on: false })
    expect(payloadFor('CLIP_SET_BRAKE', 'right')).toMatchObject({ on: true })
    expect(project.clips.c1?.brake).toBeUndefined()
    expect(project.clips.right?.brake).toBe(true)
  })

  it('hands an end-of-clip backspin to the right half only', () => {
    const project = setup(makeClip({ backspin: true }))

    project.splitClipAt('c1', 400)

    expect(payloadFor('CLIP_SET_BACKSPIN', 'c1')).toMatchObject({ on: false })
    expect(payloadFor('CLIP_SET_BACKSPIN', 'right')).toMatchObject({ on: true })
    expect(project.clips.c1?.backspin).toBeUndefined()
  })

  it('re-maps the volume shape across the seam', () => {
    const project = setup(
      makeClip({
        envelopePoints: [
          { timeMs: 0, gain: 1 },
          { timeMs: 1000, gain: 0 }
        ]
      })
    )

    project.splitClipAt('c1', 400)

    // A linear-in-dB fade sampled at the seam pins both halves to the same gain there.
    const left = project.clips.c1?.envelopePoints ?? []
    const right = project.clips.right?.envelopePoints ?? []
    expect(left[left.length - 1]?.timeMs).toBeCloseTo(400, 3)
    expect(right[0]?.timeMs).toBe(0)
    expect(right[0]?.gain).toBeCloseTo(left[left.length - 1]?.gain ?? -1, 6)
    // The right half is re-based to its own zero, not left spanning the original clip.
    expect(right[right.length - 1]?.timeMs).toBeCloseTo(600, 3)
  })

  it('leaves an unshaped clip without an envelope send', () => {
    const project = setup(makeClip())

    project.splitClipAt('c1', 400)

    expect(payloadFor('CLIP_SET_ENVELOPE', 'c1')).toBeUndefined()
    expect(payloadFor('CLIP_SET_ENVELOPE', 'right')).toBeUndefined()
  })
})
