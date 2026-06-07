import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryStore } from '@/stores/libraryStore'
import { DEFAULT_PROJECT_NAME, DEFAULT_TRACK_LENGTH_MS, useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'

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

  it('pastes to the selected track at the playhead even when copied from another track', () => {
    const project = useProjectStore()
    const sourceTrackId = project.addTrack()
    const targetTrackId = project.addTrack()
    const sourceClipId = project.addClipToTrack(
      sourceTrackId,
      {
        libraryItemId: 'lib-copy',
        filePath: 'C:\\audio\\copy.wav',
        fileName: 'copy.wav',
        durationMs: 1_000,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      0
    )
    const blockerId = project.addClipToTrack(
      sourceTrackId,
      {
        libraryItemId: 'lib-blocker',
        filePath: 'C:\\audio\\blocker.wav',
        fileName: 'blocker.wav',
        durationMs: 2_000,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      1_000
    )
    expect(sourceClipId).toBeTruthy()
    expect(blockerId).toBeTruthy()
    project.selectClip(sourceClipId)
    project.selectTrack(sourceTrackId)
    expect(project.copySelectedClip()).toBe(true)
    sendMock.mockClear()

    project.selectTrack(targetTrackId)
    const pastedId = project.pasteClipAtPlayhead(5_000)

    expect(pastedId).toBeTruthy()
    expect(project.clips[pastedId ?? '']?.trackId).toBe(targetTrackId)
    expect(project.clips[pastedId ?? '']?.startMs).toBe(5_000)
    expect(sendMock).toHaveBeenCalledWith(
      'CLIP_ADD',
      expect.objectContaining({
        trackId: targetTrackId,
        clipId: pastedId,
        positionMs: 5_000
      })
    )
  })

  it('does not split linked saved-clip timeline instances', () => {
    const project = useProjectStore()
    const library = useLibraryStore()
    const trackId = project.addTrack()
    library.addItem({
      id: 'source',
      kind: 'audio-file',
      filePath: 'C:\\audio\\loop.wav',
      fileName: 'loop.wav',
      durationMs: 4_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array(),
      fromSnapshot: true
    })
    library.addItem({
      id: 'saved',
      kind: 'saved-clip',
      filePath: 'C:\\audio\\loop.wav',
      fileName: 'loop.wav',
      durationMs: 2_000,
      sampleRate: 44_100,
      channelCount: 2,
      peaks: new Float32Array(),
      derivedFrom: {
        sourceItemId: 'source',
        sourceClipId: 'c1',
        inMs: 0,
        durationMs: 2_000
      },
      fromSnapshot: true
    })
    const clipId = project.addClipToTrack(
      trackId,
      {
        libraryItemId: 'saved',
        filePath: 'C:\\audio\\loop.wav',
        fileName: 'Loop saved',
        durationMs: 2_000,
        sampleRate: 44_100,
        channelCount: 2,
        peaks: new Float32Array()
      },
      0
    )
    sendMock.mockClear()

    const splitId = project.splitClipAt(clipId ?? '', 1_000)

    expect(splitId).toBeNull()
    expect(project.tracks[0]?.clipIds).toEqual([clipId])
    expect(sendMock).not.toHaveBeenCalledWith('CLIP_TRIM', expect.anything())
    expect(sendMock).not.toHaveBeenCalledWith('CLIP_ADD', expect.anything())
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

  it('relinks every library item sharing a missing source and refreshes placed clips', () => {
    const project = useProjectStore()
    const library = useLibraryStore()

    const missing = 'C:\\old\\song.wav'
    const found = 'C:\\new\\song.wav'

    // Initial load: an audio-file source AND a saved clip derived from it
    // both reference the same missing file, but ONLY the saved clip is
    // placed on the timeline. The audio-file source has no clip of its own.
    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\mix.silverdaw',
      name: 'Mix',
      reset: true,
      library: [
        {
          id: 'l1',
          kind: 'audio-file',
          filePath: missing,
          fileName: 'song.wav',
          durationMs: 4_000,
          sampleRate: 44_100,
          channelCount: 2,
          unresolved: true
        },
        {
          id: 'l2',
          kind: 'saved-clip',
          name: 'Chop',
          filePath: missing,
          fileName: 'song.wav',
          durationMs: 1_000,
          sourceItemId: 'l1',
          sourceClipId: 'c1',
          sourceInMs: 0,
          sourceDurationMs: 1_000,
          unresolved: true
        }
      ],
      tracks: [
        {
          id: 't1',
          name: 'T1',
          gain: 1,
          clips: [
            { id: 'c1', libraryItemId: 'l2', offsetMs: 0, inMs: 0, durationMs: 1_000, unresolved: true }
          ]
        }
      ]
    })

    // Both items — including the unplaced audio-file source — are flagged
    // unresolved, so the Relink dialog can fan out to both.
    expect(library.byId.l1?.unresolved).toBe(true)
    expect(library.byId.l2?.unresolved).toBe(true)
    expect(project.clips.c1?.filePath).toBe(missing)
    expect(project.clips.c1?.unresolved).toBe(true)

    // Relink rebroadcast: the backend re-points BOTH items and clears the
    // missing-source flags. This arrives as a normal (non-reset) snapshot.
    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\mix.silverdaw',
      name: 'Mix',
      library: [
        {
          id: 'l1',
          kind: 'audio-file',
          filePath: found,
          fileName: 'song.wav',
          durationMs: 4_000,
          sampleRate: 44_100,
          channelCount: 2
        },
        {
          id: 'l2',
          kind: 'saved-clip',
          name: 'Chop',
          filePath: found,
          fileName: 'song.wav',
          durationMs: 1_000,
          sourceItemId: 'l1',
          sourceClipId: 'c1',
          sourceInMs: 0,
          sourceDurationMs: 1_000
        }
      ],
      tracks: [
        {
          id: 't1',
          name: 'T1',
          gain: 1,
          clips: [{ id: 'c1', libraryItemId: 'l2', offsetMs: 0, inMs: 0, durationMs: 1_000 }]
        }
      ]
    })

    // Existing library items are refreshed (path updated, flag cleared) —
    // the unplaced source no longer keeps the stale path that broke the
    // saved project file.
    expect(library.byId.l1?.filePath).toBe(found)
    expect(library.byId.l1?.unresolved).toBeUndefined()
    expect(library.byId.l2?.filePath).toBe(found)
    expect(library.byId.l2?.unresolved).toBeUndefined()
    // The already-drawn clip's cached source binding follows the relink.
    expect(project.clips.c1?.filePath).toBe(found)
    expect(project.clips.c1?.unresolved).toBe(false)
  })


  it('adopts the autosave manifest id while restoring an untitled project', async () => {
    const project = useProjectStore()
    sendMock.mockReturnValueOnce(true)

    const result = project.requestLoadRecovery(
      'C:\\Users\\ira\\AppData\\Roaming\\Silverdaw\\autosave\\recovered-id\\autosave.silverdaw',
      null,
      'recovered-id'
    )
    expect(sendMock).toHaveBeenCalledWith('PROJECT_LOAD_RECOVERY', {
      autosavePath:
        'C:\\Users\\ira\\AppData\\Roaming\\Silverdaw\\autosave\\recovered-id\\autosave.silverdaw',
      originalPath: null
    })

    project.applyProjectStateSnapshot({
      filePath: null,
      name: 'Recovered Untitled',
      reset: true,
      library: [],
      tracks: []
    })

    await expect(result).resolves.toEqual({ ok: true })
    expect(project.projectId).toBe('recovered-id')
    expect(project.pendingRecoveredProjectId).toBeNull()
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

  it('updates and forwards per-track Reverb / Delay sends, suppressing defaults', () => {
    const project = useProjectStore()
    const trackId = project.addTrack()
    sendMock.mockClear()

    project.setTrackSends(trackId, { reverbSend: 0.4, delaySend: 0.25 }, { gestureEnd: true })

    const track = project.tracks.find((t) => t.id === trackId)
    expect(track?.reverbSend).toBe(0.4)
    expect(track?.delaySend).toBe(0.25)
    expect(sendMock).toHaveBeenCalledWith('TRACK_SET_SENDS', {
      trackId,
      reverbSend: 0.4,
      delaySend: 0.25,
      gestureId: undefined,
      gestureEnd: true
    })

    // Zero clamps back to undefined (default-suppressed) but is still
    // forwarded so the backend clears the stored value — and the untouched
    // sibling send is read back off the track so the wire carries both.
    sendMock.mockClear()
    project.setTrackSends(trackId, { reverbSend: 0 }, { gestureEnd: true })
    expect(track?.reverbSend).toBeUndefined()
    expect(track?.delaySend).toBe(0.25)
    expect(sendMock).toHaveBeenCalledWith('TRACK_SET_SENDS', {
      trackId,
      reverbSend: 0,
      delaySend: 0.25,
      gestureId: undefined,
      gestureEnd: true
    })

    // A mid-drag sample forwards the minted gestureId so the backend can
    // coalesce the whole drag into one undo step.
    sendMock.mockClear()
    project.setTrackSends(trackId, { delaySend: 0.5 }, { gestureId: 'drag-1', gestureEnd: false })
    expect(sendMock).toHaveBeenCalledWith('TRACK_SET_SENDS', {
      trackId,
      reverbSend: 0,
      delaySend: 0.5,
      gestureId: 'drag-1',
      gestureEnd: false
    })

    // localOnly reconciliation (the ack path) must not echo to the bridge.
    sendMock.mockClear()
    project.setTrackSends(trackId, { reverbSend: 0.6 }, { localOnly: true })
    expect(track?.reverbSend).toBe(0.6)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('updates and forwards the project Reverb and Delay, clamping to [0, 1]', () => {
    const project = useProjectStore()
    sendMock.mockClear()

    project.setProjectReverb({ size: 0.5, decay: 2, mix: -1 }, { gestureEnd: true })
    expect(project.projectReverb).toMatchObject({ size: 0.5, decay: 1, tone: 0, mix: 0 })
    expect(sendMock).toHaveBeenCalledWith('PROJECT_SET_REVERB', {
      size: 0.5,
      decay: 2,
      tone: undefined,
      mix: -1,
      gestureId: undefined,
      gestureEnd: true
    })

    project.setProjectDelay({ noteValue: '1/16', feedback: 0.7 }, { gestureEnd: true })
    expect(project.projectDelay).toMatchObject({ noteValue: '1/16', feedback: 0.7, tone: 0, mix: 0 })
    expect(sendMock).toHaveBeenCalledWith('PROJECT_SET_DELAY', {
      noteValue: '1/16',
      feedback: 0.7,
      tone: undefined,
      mix: undefined,
      gestureId: undefined,
      gestureEnd: true
    })

    // The ack path reconciles without echoing back to the bridge.
    sendMock.mockClear()
    project.setProjectReverb({ mix: 0.8 }, { localOnly: true })
    expect(project.projectReverb.mix).toBe(0.8)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('hydrates project FX and per-track sends from a snapshot', () => {
    const project = useProjectStore()

    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\fx.silverdaw',
      name: 'FX Mix',
      reset: true,
      bpm: 120,
      reverbSize: 0.6,
      reverbDecay: 0.4,
      reverbTone: 0.3,
      reverbMix: 0.5,
      delayNoteValue: '1/16',
      delayFeedback: 0.35,
      delayTone: 0.2,
      delayMix: 0.45,
      tracks: [
        {
          id: 't1',
          name: 'Synth',
          gain: 1,
          sendReverb: 0.7,
          sendDelay: 0.2,
          clips: []
        }
      ]
    })

    expect(project.projectReverb).toEqual({ size: 0.6, decay: 0.4, tone: 0.3, mix: 0.5 })
    expect(project.projectDelay).toEqual({
      noteValue: '1/16',
      feedback: 0.35,
      tone: 0.2,
      mix: 0.45
    })
    const track = project.tracks.find((t) => t.id === 't1')
    expect(track?.reverbSend).toBe(0.7)
    expect(track?.delaySend).toBe(0.2)
  })

  it('hydrates project FX to inaudible defaults when the snapshot omits them', () => {
    const project = useProjectStore()

    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\bare.silverdaw',
      name: 'Bare',
      reset: true,
      bpm: 120,
      tracks: [{ id: 't1', name: 'Track 1', gain: 1, clips: [] }]
    })

    expect(project.projectReverb).toEqual({ size: 0, decay: 0, tone: 0, mix: 0 })
    expect(project.projectDelay).toEqual({ noteValue: '1/8', feedback: 0, tone: 0, mix: 0 })
    const track = project.tracks.find((t) => t.id === 't1')
    expect(track?.reverbSend).toBeUndefined()
    expect(track?.delaySend).toBeUndefined()
  })

  it('keeps effectiveDurationMs in sync when trimming so the block width tracks the drag', () => {
    const project = useProjectStore()

    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\trim.silverdaw',
      name: 'Trim',
      reset: true,
      bpm: 120,
      library: [
        {
          id: 'l1',
          kind: 'audio-file',
          filePath: 'C:\\audio\\loop.wav',
          fileName: 'loop.wav',
          durationMs: 8_000,
          sampleRate: 44_100,
          channelCount: 2
        }
      ],
      tracks: [
        {
          id: 't1',
          name: 'T1',
          gain: 1,
          clips: [
            // Warp-active clip: source 1000 ms plays back over 500 ms of
            // timeline (ratio 2). effectiveDurationMs is the timeline footprint.
            {
              id: 'c1',
              libraryItemId: 'l1',
              offsetMs: 0,
              inMs: 0,
              durationMs: 1_000,
              effectiveDurationMs: 500,
              effectiveTempoRatio: 2,
              effectiveWarpActive: true
            },
            // Un-warped clip: timeline footprint equals the source duration.
            {
              id: 'c2',
              libraryItemId: 'l1',
              offsetMs: 2_000,
              inMs: 0,
              durationMs: 1_000,
              effectiveDurationMs: 1_000
            }
          ]
        }
      ]
    })

    // Right-edge trim on the warped clip: source 1000 → 800 ms. The timeline
    // footprint must follow (800 / ratio 2 = 400) so the drawn block shrinks.
    project.trimClip('c1', 0, 0, 800)
    expect(project.clips.c1?.durationMs).toBe(800)
    expect(project.clips.c1?.effectiveDurationMs).toBe(400)

    // Un-warped clip: effectiveDurationMs tracks durationMs 1:1.
    project.trimClip('c2', 2_000, 0, 600)
    expect(project.clips.c2?.durationMs).toBe(600)
    expect(project.clips.c2?.effectiveDurationMs).toBe(600)
  })

  it('hydrates per-track transitions from a snapshot and clears them when absent', () => {
    const project = useProjectStore()

    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\xfade.silverdaw',
      name: 'Xfade',
      reset: true,
      bpm: 120,
      tracks: [
        {
          id: 't1',
          name: 'T1',
          gain: 1,
          clips: [],
          transitions: [
            {
              id: 'tr1',
              leftClipId: 'c1',
              rightClipId: 'c2',
              recipe: { kind: 'smooth' }
            }
          ]
        }
      ]
    })

    const track = project.tracks.find((t) => t.id === 't1')
    expect(track?.transitions).toEqual([
      { id: 'tr1', leftClipId: 'c1', rightClipId: 'c2', recipe: { kind: 'smooth' } }
    ])

    // A later snapshot with no transitions resets to the suppressed default.
    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\xfade.silverdaw',
      name: 'Xfade',
      reset: true,
      bpm: 120,
      tracks: [{ id: 't1', name: 'T1', gain: 1, clips: [] }]
    })

    const cleared = project.tracks.find((t) => t.id === 't1')
    expect(cleared?.transitions).toBeUndefined()
  })

  it('sends fire-and-forget TRANSITION_* envelopes without mutating local state', () => {
    const project = useProjectStore()
    sendMock.mockClear()

    project.createTransition('t1', 'c1', 'c2')
    expect(sendMock).toHaveBeenCalledWith('TRANSITION_CREATE', {
      trackId: 't1',
      leftClipId: 'c1',
      rightClipId: 'c2'
    })

    project.createTransition('t1', 'c3', 'c4', { kind: 'smooth' })
    expect(sendMock).toHaveBeenCalledWith('TRANSITION_CREATE', {
      trackId: 't1',
      leftClipId: 'c3',
      rightClipId: 'c4',
      recipe: { kind: 'smooth' }
    })

    project.deleteTransition('t1', 'tr1')
    expect(sendMock).toHaveBeenCalledWith('TRANSITION_DELETE', {
      trackId: 't1',
      transitionId: 'tr1'
    })

    project.setTransitionRecipe('t1', 'tr1', { kind: 'smooth' })
    expect(sendMock).toHaveBeenCalledWith('TRANSITION_SET_RECIPE', {
      trackId: 't1',
      transitionId: 'tr1',
      recipe: { kind: 'smooth' }
    })
  })

  it('emits TRANSITION_CREATE after a right-edge trim overlaps a following clip', () => {
    const project = useProjectStore()

    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\xfade.silverdaw',
      name: 'Xfade',
      reset: true,
      bpm: 120,
      library: [
        {
          id: 'l1',
          kind: 'audio-file',
          filePath: 'C:\\audio\\loop.wav',
          fileName: 'loop.wav',
          durationMs: 8_000,
          sampleRate: 44_100,
          channelCount: 2
        }
      ],
      tracks: [
        {
          id: 't1',
          name: 'T1',
          gain: 1,
          clips: [
            { id: 'c1', libraryItemId: 'l1', offsetMs: 0, inMs: 0, durationMs: 1_000 },
            { id: 'c2', libraryItemId: 'l1', offsetMs: 800, inMs: 0, durationMs: 1_000 }
          ]
        }
      ]
    })
    sendMock.mockClear()

    // c1's tail (ends 1000) overlaps c2's head (starts 800) by 200 ms.
    project.maybeCreateTransitionAfterTrim('c1', 'right')
    expect(sendMock).toHaveBeenCalledWith('TRANSITION_CREATE', {
      trackId: 't1',
      leftClipId: 'c1',
      rightClipId: 'c2'
    })
  })

  it('does not emit TRANSITION_CREATE when clips do not overlap', () => {
    const project = useProjectStore()

    project.applyProjectStateSnapshot({
      filePath: 'C:\\projects\\xfade.silverdaw',
      name: 'Xfade',
      reset: true,
      bpm: 120,
      library: [
        {
          id: 'l1',
          kind: 'audio-file',
          filePath: 'C:\\audio\\loop.wav',
          fileName: 'loop.wav',
          durationMs: 8_000,
          sampleRate: 44_100,
          channelCount: 2
        }
      ],
      tracks: [
        {
          id: 't1',
          name: 'T1',
          gain: 1,
          clips: [
            { id: 'c1', libraryItemId: 'l1', offsetMs: 0, inMs: 0, durationMs: 1_000 },
            { id: 'c2', libraryItemId: 'l1', offsetMs: 1_500, inMs: 0, durationMs: 1_000 }
          ]
        }
      ]
    })
    sendMock.mockClear()

    project.maybeCreateTransitionAfterTrim('c1', 'right')
    expect(sendMock).not.toHaveBeenCalledWith('TRANSITION_CREATE', expect.anything())
  })
})
