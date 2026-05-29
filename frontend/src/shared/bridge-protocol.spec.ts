import { describe, expect, it } from 'vitest'
import {
  isClipRemovedPayload,
  isClipWarpAppliedPayload,
  isBridgeInboundType,
  isClipAckPayload,
  isLibraryItemAnalysisPayload,
  isPlayheadUpdatePayload,
  isPreviewEndedPayload,
  isPreviewPositionPayload,
  isPreviewStatePayload,
  isProjectBpmAppliedPayload,
  isProjectDirtyPayload,
  isProjectLoadFailedPayload,
  isProjectRenamedPayload,
  isProjectSavedPayload,
  isProjectViewStateSavedPayload,
  isProjectStatePayload,
  isReadyPayload,
  isSampleSavedPayload,
  isTrackAddedPayload,
  isTrackGainAppliedPayload,
  isTrackRemovedPayload,
  isWaveformReadyPayload,
  type BridgeInboundType
} from './bridge-protocol'

const INBOUND_TYPES = {
  READY: true,
  PROJECT_STATE: true,
  PLAYHEAD_UPDATE: true,
  CLIP_ADDED: true,
  CLIP_ADD_FAILED: true,
  TRACK_ADDED: true,
  TRACK_REMOVED: true,
  CLIP_REMOVED: true,
  TRACK_GAIN_APPLIED: true,
  TRACK_MUTE_APPLIED: true,
  TRACK_SOLO_APPLIED: true,
  PROJECT_SAVED: true,
  PROJECT_VIEW_STATE_SAVED: true,
  PROJECT_AUTOSAVED: true,
  PROJECT_LOAD_FAILED: true,
  PROJECT_RENAMED: true,
  PROJECT_DIRTY: true,
  WAVEFORM_READY: true,
  CLIP_EDITOR_PEAKS_READY: true,
  SAMPLE_SAVED: true,
  LIBRARY_ITEM_ANALYSIS: true,
  CLIP_WARP_APPLIED: true,
  PROJECT_BPM_APPLIED: true,
  PREVIEW_STATE: true,
  PREVIEW_POSITION: true,
  PREVIEW_ENDED: true,
  AUDIO_DEVICES_LIST: true,
  AUDIO_DEVICE_CHANGED: true,
  EDIT_UNDO_STATE: true,
  AUDIO_FILE_PROBED: true,
  MIXDOWN_PROGRESS: true,
  MIXDOWN_DONE: true,
  MIXDOWN_FAILED: true,
  MASTER_LEVEL: true,
  TRACK_LEVELS: true,
  TRACK_SENDS_APPLIED: true,
  TRACK_TONE_APPLIED: true,
  TRACK_LEVELER_APPLIED: true,
  CLIP_FADES_APPLIED: true,
  CLIP_ENVELOPE_APPLIED: true,
  PROJECT_REVERB_APPLIED: true,
  PROJECT_DELAY_APPLIED: true
} satisfies Record<BridgeInboundType, true>

describe('isBridgeInboundType', () => {
  it('accepts every inbound type', () => {
    for (const t of Object.keys(INBOUND_TYPES)) {
      expect(isBridgeInboundType(t)).toBe(true)
    }
  })

  it('rejects unknown strings', () => {
    expect(isBridgeInboundType('NOT_REAL')).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isBridgeInboundType(42)).toBe(false)
    expect(isBridgeInboundType(null)).toBe(false)
    expect(isBridgeInboundType(undefined)).toBe(false)
  })
})

describe('isReadyPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isReadyPayload({ version: '0.1.0' })).toBe(true)
  })

  it('rejects missing or wrong-typed version', () => {
    expect(isReadyPayload({})).toBe(false)
    expect(isReadyPayload({ version: 1 })).toBe(false)
  })
})

describe('isPlayheadUpdatePayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isPlayheadUpdatePayload({ positionMs: 0, isPlaying: false })).toBe(true)
  })

  it('rejects missing fields', () => {
    expect(isPlayheadUpdatePayload({ positionMs: 0 })).toBe(false)
    expect(isPlayheadUpdatePayload({ isPlaying: false })).toBe(false)
  })

  it('rejects wrong-typed fields', () => {
    expect(isPlayheadUpdatePayload({ positionMs: '0', isPlaying: false })).toBe(false)
  })
})

describe('isClipAckPayload', () => {
  it('accepts a success ack (no error field)', () => {
    expect(isClipAckPayload({ trackId: 't1', clipId: 'c1', libraryItemId: 'l1', ok: true })).toBe(true)
  })

  it('accepts a failure ack with an error string', () => {
    expect(
      isClipAckPayload({ trackId: 't1', clipId: 'c1', libraryItemId: 'l1', ok: false, error: 'boom' })
    ).toBe(true)
  })

  it('rejects an ack with a non-string error', () => {
    expect(
      isClipAckPayload({ trackId: 't1', clipId: 'c1', libraryItemId: 'l1', ok: false, error: 42 })
    ).toBe(false)
  })

  it('rejects missing required fields', () => {
    expect(isClipAckPayload({ clipId: 'c1', libraryItemId: 'l1', ok: true })).toBe(false)
    expect(isClipAckPayload({ trackId: 't1', libraryItemId: 'l1', ok: true })).toBe(false)
    expect(isClipAckPayload({ trackId: 't1', clipId: 'c1', ok: true })).toBe(false)
    expect(isClipAckPayload({ trackId: 't1', clipId: 'c1', libraryItemId: 'l1' })).toBe(false)
  })
})

describe('isTrackAddedPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isTrackAddedPayload({ trackId: 't1', ok: true })).toBe(true)
    expect(isTrackAddedPayload({ trackId: 't1', ok: false })).toBe(true)
  })

  it('rejects missing or wrong-typed fields', () => {
    expect(isTrackAddedPayload({ trackId: 't1' })).toBe(false)
    expect(isTrackAddedPayload({ ok: true })).toBe(false)
  })
})

describe('isTrackRemovedPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isTrackRemovedPayload({ trackId: 't1', ok: true })).toBe(true)
    expect(isTrackRemovedPayload({ trackId: 't1', ok: false })).toBe(true)
  })

  it('rejects missing or wrong-typed fields', () => {
    expect(isTrackRemovedPayload({ trackId: 't1' })).toBe(false)
    expect(isTrackRemovedPayload({ ok: true })).toBe(false)
    expect(isTrackRemovedPayload({ trackId: 1, ok: true })).toBe(false)
    expect(isTrackRemovedPayload({ trackId: 't1', ok: 'yes' })).toBe(false)
  })
})

describe('isTrackGainAppliedPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isTrackGainAppliedPayload({ trackId: 't1', gain: 0.5, ok: true })).toBe(true)
    expect(isTrackGainAppliedPayload({ trackId: 't1', gain: 0, ok: false })).toBe(true)
  })

  it('rejects missing or wrong-typed fields', () => {
    expect(isTrackGainAppliedPayload({ trackId: 't1', gain: 0.5 })).toBe(false)
    expect(isTrackGainAppliedPayload({ trackId: 't1', ok: true })).toBe(false)
    expect(isTrackGainAppliedPayload({ gain: 0.5, ok: true })).toBe(false)
    expect(isTrackGainAppliedPayload({ trackId: 't1', gain: '0.5', ok: true })).toBe(false)
  })
})

describe('isProjectStatePayload', () => {
  const base = { filePath: null as string | null, name: 'Untitled' }

  it('accepts an empty project', () => {
    expect(isProjectStatePayload({ ...base, tracks: [] })).toBe(true)
  })

  it('accepts a project with filePath and reset flag', () => {
    expect(
      isProjectStatePayload({ filePath: '/p/x.silverdaw', name: 'x', reset: true, tracks: [] })
    ).toBe(true)
  })

  it('accepts tracks with clips', () => {
    expect(
      isProjectStatePayload({
        ...base,
        markers: [{ id: 'm1', positionMs: 1250 }],
        library: [
          {
            id: 'l1',
            filePath: '/sample.wav',
            kind: 'audio-file',
            fileName: 'sample.wav',
            durationMs: 1000,
            sampleRate: 44100,
            channelCount: 2,
            key: 'C minor',
            bpm: 124.5,
            beats: [0.25, 0.75],
            beatAnchorSec: 0.25,
            playbackFilePath: '/cache/sample.wav',
            variableTempo: true,
            unresolved: false
          },
          {
            id: 'l2',
            filePath: '/sample.wav',
            kind: 'saved-clip',
            name: 'Sample chop',
            fileName: 'sample.wav',
            durationMs: 500,
            sourceItemId: 'l1',
            sourceClipId: 'c1',
            sourceInMs: 250,
            sourceDurationMs: 500
          }
        ],
        tracks: [
          {
            id: 't1',
            gain: 1.0,
            clips: [
              {
                id: 'c1',
                libraryItemId: 'l1',
                offsetMs: 0,
                inMs: 25,
                durationMs: 1000,
                colorIndex: 4,
                unresolved: true
              }
            ]
          }
        ]
      })
    ).toBe(true)
  })

  it('rejects missing name or wrong-typed filePath', () => {
    expect(isProjectStatePayload({ filePath: null, tracks: [] })).toBe(false)
    expect(isProjectStatePayload({ name: 'x', tracks: [] })).toBe(false)
    expect(isProjectStatePayload({ filePath: 123, name: 'x', tracks: [] })).toBe(false)
  })

  it('rejects missing or wrong-typed track fields', () => {
    expect(isProjectStatePayload({})).toBe(false)
    expect(isProjectStatePayload({ ...base, tracks: [{ id: 't1', clips: [] }] })).toBe(false)
    expect(
      isProjectStatePayload({ ...base, tracks: [{ id: 't1', gain: '1.0', clips: [] }] })
    ).toBe(false)
    expect(isProjectStatePayload({ ...base, tracks: [{ id: 't1', gain: 1.0 }] })).toBe(false)
  })

  it('rejects malformed clip entries', () => {
    expect(
      isProjectStatePayload({
        ...base,
        tracks: [{ id: 't1', gain: 1.0, clips: [{ id: 'c1', libraryItemId: 'lib1', offsetMs: 0 }] }]
      })
    ).toBe(false)
    expect(
      isProjectStatePayload({
        ...base,
        tracks: [{ id: 't1', gain: 1.0, clips: [{ libraryItemId: 'lib1', offsetMs: 0, durationMs: 1 }] }]
      })
    ).toBe(false)
    expect(
      isProjectStatePayload({
        ...base,
        library: [{ id: 'l1', filePath: '/sample.wav', durationMs: '1000' }],
        tracks: []
      })
    ).toBe(false)
    expect(
      isProjectStatePayload({
        ...base,
        library: [{ id: 'l1', filePath: '/sample.wav', sampleRate: '44100' }],
        tracks: []
      })
    ).toBe(false)
    expect(
      isProjectStatePayload({
        ...base,
        library: [{ id: 'l1', filePath: '/sample.wav', key: 7 }],
        tracks: []
      })
    ).toBe(false)
    expect(
      isProjectStatePayload({
        ...base,
        library: [{ id: 'l1', filePath: '/sample.wav', beats: [0.1, 'bad'] }],
        tracks: []
      })
    ).toBe(false)
    expect(
      isProjectStatePayload({
        ...base,
        library: [{ id: 'l1', filePath: '/sample.wav', variableTempo: 'yes' }],
        tracks: []
      })
    ).toBe(false)
    expect(
      isProjectStatePayload({
        ...base,
        library: [{ id: 'l2', filePath: '/sample.wav', kind: 'saved-clip', sourceInMs: 0 }],
        tracks: []
      })
    ).toBe(false)
    expect(
      isProjectStatePayload({
        ...base,
        tracks: [
          {
            id: 't1',
            gain: 1.0,
            clips: [{ id: 'c1', libraryItemId: 'lib1', offsetMs: 0, durationMs: 1, unresolved: 'yes' }]
          }
        ]
      })
    ).toBe(false)
    expect(isProjectStatePayload({ ...base, markers: [{ id: 'm1' }], tracks: [] })).toBe(false)
    expect(isProjectStatePayload({ ...base, markers: [{ id: 'm1', positionMs: '1000' }], tracks: [] })).toBe(false)
  })
})

describe('isProjectSavedPayload', () => {
  it('accepts ok and failure shapes', () => {
    expect(isProjectSavedPayload({ filePath: '/p.silverdaw', ok: true })).toBe(true)
    expect(isProjectSavedPayload({ filePath: '/p.silverdaw', ok: false, error: 'oops' })).toBe(true)
  })

  it('rejects missing fields and wrong types', () => {
    expect(isProjectSavedPayload({ filePath: '/p', ok: 'yes' })).toBe(false)
    expect(isProjectSavedPayload({ ok: true })).toBe(false)
    expect(isProjectSavedPayload({ filePath: '/p', ok: false, error: 123 })).toBe(false)
  })
})

describe('isProjectViewStateSavedPayload', () => {
  it('accepts ok and failure shapes', () => {
    expect(isProjectViewStateSavedPayload({ filePath: '/p.silverdaw', ok: true })).toBe(true)
    expect(
      isProjectViewStateSavedPayload({ filePath: '/p.silverdaw', ok: false, error: 'oops' })
    ).toBe(true)
  })

  it('rejects missing fields and wrong types', () => {
    expect(isProjectViewStateSavedPayload({ filePath: '/p', ok: 'yes' })).toBe(false)
    expect(isProjectViewStateSavedPayload({ ok: true })).toBe(false)
    expect(isProjectViewStateSavedPayload({ filePath: '/p', ok: false, error: 123 })).toBe(false)
  })
})

describe('isProjectLoadFailedPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isProjectLoadFailedPayload({ filePath: '/p.silverdaw', error: 'bad' })).toBe(true)
  })

  it('rejects missing fields', () => {
    expect(isProjectLoadFailedPayload({ filePath: '/p' })).toBe(false)
    expect(isProjectLoadFailedPayload({ error: 'bad' })).toBe(false)
  })
})

describe('isProjectRenamedPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isProjectRenamedPayload({ name: 'My Mix', ok: true })).toBe(true)
  })

  it('rejects wrong-typed fields', () => {
    expect(isProjectRenamedPayload({ name: 'x' })).toBe(false)
    expect(isProjectRenamedPayload({ name: 1, ok: true })).toBe(false)
  })
})

describe('isWaveformReadyPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(
      isWaveformReadyPayload({
        clipId: 'c1',
        cachePath: 'C:/x/y.peaks',
        peakCount: 1000,
        peaksPerSecond: 200,
        sampleRate: 44100
      })
    ).toBe(true)
  })

  it('rejects missing or wrong-typed fields', () => {
    expect(isWaveformReadyPayload({ clipId: 'c1' })).toBe(false)
    expect(
      isWaveformReadyPayload({
        clipId: 'c1',
        cachePath: '/x',
        peakCount: '1000',
        peaksPerSecond: 200,
        sampleRate: 44100
      })
    ).toBe(false)
  })
})

describe('isSampleSavedPayload', () => {
  it('accepts a successful sample payload', () => {
    expect(
      isSampleSavedPayload({
        clipId: 'c1',
        itemId: 'sample-1',
        filePath: 'C:\\Samples\\Kick.wav',
        fileName: 'Kick.wav',
        name: 'Kick',
        durationMs: 1000,
        sampleRate: 44100,
        channelCount: 2,
        cachePath: 'C:\\peaks\\x.peaks',
        peakCount: 500,
        peaksPerSecond: 500,
        ok: true
      })
    ).toBe(true)
  })

  it('rejects missing success fields', () => {
    expect(isSampleSavedPayload({ itemId: 'x', ok: true })).toBe(false)
  })

  it('accepts a failed sample payload without file metadata', () => {
    expect(isSampleSavedPayload({ itemId: 'sample-1', clipId: 'c1', ok: false, error: 'nope' })).toBe(true)
  })
})

describe('isClipRemovedPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isClipRemovedPayload({ clipId: 'c1', ok: true })).toBe(true)
    expect(isClipRemovedPayload({ clipId: 'c1', ok: false })).toBe(true)
  })

  it('rejects missing or wrong-typed fields', () => {
    expect(isClipRemovedPayload({ clipId: 'c1' })).toBe(false)
    expect(isClipRemovedPayload({ ok: true })).toBe(false)
    expect(isClipRemovedPayload({ clipId: 1, ok: true })).toBe(false)
  })
})

describe('isProjectDirtyPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isProjectDirtyPayload({ dirty: true })).toBe(true)
    expect(isProjectDirtyPayload({ dirty: false })).toBe(true)
  })

  it('rejects missing or wrong-typed fields', () => {
    expect(isProjectDirtyPayload({})).toBe(false)
    expect(isProjectDirtyPayload({ dirty: 'yes' })).toBe(false)
  })
})

describe('isLibraryItemAnalysisPayload', () => {
  it('accepts a complete analysis payload', () => {
    expect(
      isLibraryItemAnalysisPayload({
        itemId: 'l1',
        bpm: 124.5,
        beatAnchorSec: 0.25,
        beats: [0.25, 0.75],
        variableTempo: false,
        playbackFilePath: '/cache/source.wav'
      })
    ).toBe(true)
  })

  it('rejects malformed beat arrays and optional fields', () => {
    expect(
      isLibraryItemAnalysisPayload({
        itemId: 'l1',
        bpm: 124.5,
        beatAnchorSec: 0.25,
        beats: [0.25, 'bad'],
        variableTempo: false
      })
    ).toBe(false)
    expect(
      isLibraryItemAnalysisPayload({
        itemId: 'l1',
        bpm: 124.5,
        beatAnchorSec: 0.25,
        beats: [0.25],
        variableTempo: false,
        playbackFilePath: 123
      })
    ).toBe(false)
  })
})

describe('isProjectBpmAppliedPayload', () => {
  it('accepts a numeric BPM', () => {
    expect(isProjectBpmAppliedPayload({ bpm: 124.5 })).toBe(true)
  })

  it('rejects missing or wrong-typed BPM', () => {
    expect(isProjectBpmAppliedPayload({})).toBe(false)
    expect(isProjectBpmAppliedPayload({ bpm: '124.5' })).toBe(false)
  })
})

describe('isClipWarpAppliedPayload', () => {
  it('accepts a well-shaped warp update payload', () => {
    expect(
      isClipWarpAppliedPayload({
        clipId: 'c1',
        warpEnabled: true,
        warpMode: 'rhythmic',
        pendingAutoWarp: false
      })
    ).toBe(true)
    expect(
      isClipWarpAppliedPayload({
        clipId: 'c1',
        tempoRatio: null
      })
    ).toBe(true)
  })

  it('rejects malformed fields', () => {
    expect(isClipWarpAppliedPayload({ clipId: 1 })).toBe(false)
    expect(isClipWarpAppliedPayload({ clipId: 'c1', warpMode: 'bad' })).toBe(false)
    expect(isClipWarpAppliedPayload({ clipId: 'c1', pendingAutoWarp: 'yes' })).toBe(false)
  })
})

describe('isPreviewStatePayload', () => {
  it('accepts a fully populated payload', () => {
    expect(
      isPreviewStatePayload({
        libraryItemId: 'lib1',
        isPlaying: false,
        isLoaded: true,
        durationMs: 1_000,
        generation: 3
      })
    ).toBe(true)
  })
  it('accepts payload without libraryItemId', () => {
    expect(
      isPreviewStatePayload({ isPlaying: false, isLoaded: false, durationMs: 0, generation: 1 })
    ).toBe(true)
  })
  it('rejects wrong-typed fields', () => {
    expect(isPreviewStatePayload({ isPlaying: 'no', isLoaded: true, durationMs: 0, generation: 1 })).toBe(false)
    expect(isPreviewStatePayload({ isPlaying: false, isLoaded: true, durationMs: '0', generation: 1 })).toBe(false)
  })
})

describe('isPreviewPositionPayload', () => {
  it('accepts a populated payload', () => {
    expect(isPreviewPositionPayload({ positionMs: 250, isPlaying: true, generation: 1 })).toBe(true)
  })
  it('rejects missing fields', () => {
    expect(isPreviewPositionPayload({ positionMs: 250 })).toBe(false)
  })
})

describe('isPreviewEndedPayload', () => {
  it('accepts a generation number', () => {
    expect(isPreviewEndedPayload({ generation: 2 })).toBe(true)
  })
  it('rejects non-numeric generation', () => {
    expect(isPreviewEndedPayload({ generation: '2' })).toBe(false)
  })
})
