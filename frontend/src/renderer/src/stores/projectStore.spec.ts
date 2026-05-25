import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from './libraryStore'
import { DEFAULT_PROJECT_NAME, DEFAULT_TRACK_LENGTH_MS, useProjectStore } from './projectStore'
import { useTransportStore } from './transportStore'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))

vi.mock('@/lib/log', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

vi.mock('@/lib/audio', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

let uuidCounter = 0

function stubGlobals(): void {
  uuidCounter = 0
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => `uuid-${++uuidCounter}`)
  })
  vi.stubGlobal('window', {
    silverdaw: {
      readAudioMetadata: vi.fn().mockResolvedValue(null),
      readAudioFile: vi.fn().mockResolvedValue(null)
    }
  })
}

describe('projectStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sendMock.mockClear()
    stubGlobals()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts from a clean untitled project', () => {
    const project = useProjectStore()

    expect(project.tracks).toEqual([])
    expect(project.clips).toEqual({})
    expect(project.projectName).toBe(DEFAULT_PROJECT_NAME)
    expect(project.isDirty).toBe(false)
    expect(project.durationMs).toBe(0)
  })

  it('adds tracks and local clips while notifying the bridge about tracks', () => {
    const project = useProjectStore()

    const trackId = project.addTrack()
    const clipId = project.addClipToTrack(
      trackId,
      {
        libraryItemId: 'lib-drums',
        filePath: 'C:\\audio\\drums.wav',
        fileName: 'drums.wav',
        durationMs: 2_000,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array([0, 1])
      },
      500
    )

    expect(trackId).toBe('uuid-1')
    expect(clipId).toBe('uuid-2')
    expect(project.tracks).toHaveLength(1)
    expect(project.tracks[0]?.name).toBe('drums')
    expect(project.tracks[0]?.lengthMs).toBe(DEFAULT_TRACK_LENGTH_MS)
    expect(project.clips[clipId ?? '']?.startMs).toBe(500)
    expect(project.durationMs).toBe(DEFAULT_TRACK_LENGTH_MS)
    expect(sendMock).toHaveBeenCalledWith('TRACK_ADD', { trackId, name: 'Track 1' })
  })

  it('clamps same-track clip moves to the nearest non-overlapping slot', () => {
    const project = useProjectStore()
    const trackId = project.addTrack()
    const firstClipId = project.addClipToTrack(
      trackId,
      {
        libraryItemId: 'lib-a',
        filePath: 'C:\\audio\\a.wav',
        fileName: 'a.wav',
        durationMs: 1_000,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      0
    )
    const secondClipId = project.addClipToTrack(
      trackId,
      {
        libraryItemId: 'lib-b',
        filePath: 'C:\\audio\\b.wav',
        fileName: 'b.wav',
        durationMs: 500,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      2_000
    )
    sendMock.mockClear()

    project.moveClip(secondClipId ?? '', 250)

    expect(project.clips[firstClipId ?? '']?.startMs).toBe(0)
    expect(project.clips[secondClipId ?? '']?.startMs).toBe(1_000)
    expect(sendMock).toHaveBeenCalledWith('CLIP_MOVE', {
      clipId: secondClipId,
      positionMs: 1_000
    })
  })

  it('does not shorten project length below the longest clip end', () => {
    const project = useProjectStore()
    const trackId = project.addTrack()
    const clipId = project.addClipToTrack(
      trackId,
      {
        libraryItemId: 'lib-long',
        filePath: 'C:\\audio\\long.wav',
        fileName: 'long.wav',
        durationMs: 2_000,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      8_000
    )

    expect(clipId).toBeTruthy()
    expect(project.longestClipEndMs).toBe(10_000)

    project.setProjectLengthMs(5_000)

    expect(project.durationMs).toBe(10_000)
    expect(project.tracks[0]?.lengthMs).toBe(10_000)
  })

  it('applies reset snapshots across project, library, transport, and bridge requests', () => {
    const project = useProjectStore()
    const library = useLibraryStore()
    const transport = useTransportStore()
    const staleTrackId = project.addTrack()
    project.addClipToTrack(
      staleTrackId,
      {
        libraryItemId: 'lib-stale',
        filePath: 'C:\\audio\\stale.wav',
        fileName: 'stale.wav',
        durationMs: 1_000,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array([0, 1])
      },
      0
    )
    library.addItem({
      id: 'l-old',
      filePath: 'C:\\audio\\stale.wav',
      fileName: 'stale.wav',
      durationMs: 1_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array(),
      fromSnapshot: true
    })
    sendMock.mockClear()

    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\mix.silverdaw',
      name: 'Reloaded Mix',
      reset: true,
      viewPxPerSecond: 150,
      viewScrollX: 320,
      playheadMs: 2_500,
      bpm: 124.5,
      projectLengthMs: 180_000,
      markers: [
        { id: 'm2', positionMs: 4_000 },
        { id: 'm1', positionMs: 1_000 }
      ],
      library: [
        {
          id: 'l7',
          filePath: 'C:\\audio\\loop.wav',
          kind: 'audio-file',
          fileName: 'loop.wav',
          durationMs: 4_000,
          sampleRate: 48_000,
          channelCount: 2,
          key: 'C minor',
          bpm: 124.5,
          beats: [0.25, 0.75],
          beatAnchorSec: 0.25,
          playbackFilePath: 'C:\\cache\\loop.wav',
          variableTempo: true
        },
        {
          id: 'l8',
          filePath: 'C:\\audio\\loop.wav',
          kind: 'saved-clip',
          name: 'Loop chop',
          fileName: 'loop.wav',
          durationMs: 1_000,
          sourceItemId: 'l7',
          sourceClipId: 'c1',
          sourceInMs: 500,
          sourceDurationMs: 1_000
        }
      ],
      tracks: [
        {
          id: 't1',
          name: 'Drums',
          gain: 0.75,
          clips: [
            {
              id: 'c1',
              libraryItemId: 'l7',
              offsetMs: 1_000,
              inMs: 250,
              durationMs: 2_000,
              colorIndex: 3,
              unresolved: false
            }
          ]
        }
      ]
    })

    expect(project.currentFilePath).toBe('C:\\projects\\mix.silverdaw')
    expect(project.projectName).toBe('Reloaded Mix')
    expect(project.isDirty).toBe(false)
    expect(project.viewPxPerSecond).toBe(150)
    expect(project.viewScrollX).toBe(320)
    expect(transport.bpm).toBe(124.5)
    expect(transport.positionMs).toBe(2_500)
    expect(project.markers.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(project.tracks).toHaveLength(1)
    expect(project.tracks[0]).toMatchObject({
      id: 't1',
      name: 'Drums',
      volume: 0.75,
      lengthMs: 180_000
    })
    expect(project.clips.c1).toMatchObject({
      id: 'c1',
      trackId: 't1',
      libraryItemId: 'l7',
      filePath: 'C:\\audio\\loop.wav',
      startMs: 1_000,
      inMs: 250,
      durationMs: 2_000,
      unresolved: false,
      colorIndex: 3
    })
    expect(library.items).toHaveLength(2)
    expect(library.items[0]).toMatchObject({
      id: 'l7',
      kind: 'audio-file',
      filePath: 'C:\\audio\\loop.wav',
      bpm: 124.5,
      beatAnchorSec: 0.25,
      beats: [0.25, 0.75],
      variableTempo: true,
      decodedCacheFilePath: 'C:\\cache\\loop.wav'
    })
    expect(library.items[1]).toMatchObject({
      id: 'l8',
      kind: 'saved-clip',
      name: 'Loop chop',
      derivedFrom: {
        sourceItemId: 'l7',
        sourceClipId: 'c1',
        inMs: 500,
        durationMs: 1_000
      }
    })
    expect(sendMock).not.toHaveBeenCalledWith('LIBRARY_ADD', expect.anything())
    expect(sendMock).toHaveBeenCalledWith('WAVEFORM_REQUEST', { clipId: 'c1' })
  })

  it('places saved library clips using their source trim window', () => {
    const project = useProjectStore()
    const trackId = project.addTrack()
    sendMock.mockClear()

    const clipId = project.addClipFromLibrary(
      trackId,
      {
        id: 'l2',
        kind: 'saved-clip',
        name: 'Vocal chop',
        filePath: 'C:\\audio\\vocal.wav',
        fileName: 'vocal.wav',
        durationMs: 1_500,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array([0, 1]),
        playbackFilePath: 'C:\\audio\\vocal.wav',
        derivedFrom: {
          sourceItemId: 'l1',
          sourceClipId: 'c1',
          inMs: 2_000,
          durationMs: 1_500
        }
      },
      3_000
    )

    expect(clipId).toBe('uuid-2')
    expect(project.clips[clipId ?? '']).toMatchObject({
      libraryItemId: 'l2',
      fileName: 'Vocal chop',
      name: 'Vocal chop',
      inMs: 2_000,
      durationMs: 1_500
    })
    expect(sendMock).toHaveBeenCalledWith('CLIP_ADD', {
      trackId,
      clipId,
      libraryItemId: 'l2',
      positionMs: 3_000,
      inMs: 2_000,
      durationMs: 1_500
    })
    expect(sendMock).toHaveBeenCalledWith('CLIP_RENAME', {
      clipId,
      name: 'Vocal chop'
    })
  })
})
