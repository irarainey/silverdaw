import { describe, expect, it } from 'vitest'
import {
  isBridgeInboundType,
  isClipAckPayload,
  isPlayheadUpdatePayload,
  isProjectLoadFailedPayload,
  isProjectRenamedPayload,
  isProjectSavedPayload,
  isProjectStatePayload,
  isReadyPayload,
  isTrackAddedPayload,
  isTrackGainAppliedPayload,
  isTrackRemovedPayload,
  isWaveformReadyPayload
} from './bridge-protocol'

describe('isBridgeInboundType', () => {
  it('accepts every inbound type', () => {
    for (const t of [
      'READY',
      'PROJECT_STATE',
      'PLAYHEAD_UPDATE',
      'CLIP_ADDED',
      'CLIP_ADD_FAILED',
      'TRACK_ADDED',
      'TRACK_REMOVED',
      'TRACK_GAIN_APPLIED',
      'PROJECT_SAVED',
      'PROJECT_LOAD_FAILED',
      'PROJECT_RENAMED',
      'WAVEFORM_READY'
    ]) {
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
    expect(isClipAckPayload({ trackId: 't1', clipId: 'c1', filePath: '/p', ok: true })).toBe(true)
  })

  it('accepts a failure ack with an error string', () => {
    expect(
      isClipAckPayload({ trackId: 't1', clipId: 'c1', filePath: '/p', ok: false, error: 'boom' })
    ).toBe(true)
  })

  it('rejects an ack with a non-string error', () => {
    expect(
      isClipAckPayload({ trackId: 't1', clipId: 'c1', filePath: '/p', ok: false, error: 42 })
    ).toBe(false)
  })

  it('rejects missing required fields', () => {
    expect(isClipAckPayload({ clipId: 'c1', filePath: '/p', ok: true })).toBe(false)
    expect(isClipAckPayload({ trackId: 't1', filePath: '/p', ok: true })).toBe(false)
    expect(isClipAckPayload({ trackId: 't1', clipId: 'c1', ok: true })).toBe(false)
    expect(isClipAckPayload({ trackId: 't1', clipId: 'c1', filePath: '/p' })).toBe(false)
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
            fileName: 'sample.wav',
            durationMs: 1000,
            sampleRate: 44100,
            channelCount: 2,
            key: 'C minor'
          }
        ],
        tracks: [
          {
            id: 't1',
            gain: 1.0,
            clips: [{ id: 'c1', filePath: '/p', offsetMs: 0, durationMs: 1000 }]
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
        tracks: [{ id: 't1', gain: 1.0, clips: [{ id: 'c1', filePath: '/p', offsetMs: 0 }] }]
      })
    ).toBe(false)
    expect(
      isProjectStatePayload({
        ...base,
        tracks: [{ id: 't1', gain: 1.0, clips: [{ filePath: '/p', offsetMs: 0, durationMs: 1 }] }]
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
