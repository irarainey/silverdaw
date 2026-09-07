import { describe, expect, it } from 'vitest'
import {
  RecordingCommitPayloadSchema,
  RecordingSessionStatePayloadSchema
} from '@shared/bridge-protocol'

// A recording state snapshot is the only thing that tells the dialog what the backend is
// doing. Anything that makes the renderer reject one leaves the user looking at a stale
// screen with no way back, so the parsing rules matter as much as the fields do.

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    sessionId: 'session-1',
    status: 'error',
    input: null,
    firstChannel: 0,
    channelCount: 1,
    countInBars: 0,
    clickEnabled: false,
    backingTrackIds: [],
    backingGain: 1,
    inputGainDb: 0,
    recordingMode: 'music',
    monitorEnabled: false,
    monitorAvailable: true,
    cleanupEnabled: false,
    windowMode: 'playhead',
    hasSelection: false,
    anchorMs: 0,
    latencyMs: 0,
    windowEndMs: null,
    recordedMs: 0,
    droppedSamples: 0,
    ...overrides
  }
}

describe('RECORD_SESSION_STATE error codes', () => {
  it('accepts every code the backend can publish', () => {
    for (const code of [
      'noInput',
      'openFailed',
      'silentInput',
      'deviceLost',
      'transportFailed',
      'diskFull',
      'writeFailed'
    ]) {
      const parsed = RecordingSessionStatePayloadSchema.safeParse(makeState({ errorCode: code }))
      expect(parsed.success, code).toBe(true)
    }
  })

  it('keeps the snapshot when the code is one it does not know', () => {
    // A newer backend naming a failure the renderer has never heard of must not cost the
    // user the whole state: the generic message plus the backend's own wording is far
    // better than a dialog frozen on the last thing it understood.
    const parsed = RecordingSessionStatePayloadSchema.safeParse(
      makeState({ errorCode: 'somethingNewer', error: 'The backend explained itself' })
    )
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.errorCode).toBeUndefined()
    expect(parsed.success && parsed.data.error).toBe('The backend explained itself')
  })
})

describe('RECORD_SESSION_STATE monitor availability', () => {
  it('assumes monitoring is available when the backend does not say', () => {
    const state = makeState()
    delete state.monitorAvailable
    const parsed = RecordingSessionStatePayloadSchema.safeParse(state)
    expect(parsed.success && parsed.data.monitorAvailable).toBe(true)
  })

  it('carries a refusal through', () => {
    const parsed = RecordingSessionStatePayloadSchema.safeParse(
      makeState({ monitorAvailable: false })
    )
    expect(parsed.success && parsed.data.monitorAvailable).toBe(false)
  })
})

describe('RECORD_RECORDING_COMMIT channel splitting', () => {
  const base = {
    protocolVersion: 1,
    sessionId: 'session-1',
    recordingId: 'capture-1',
    itemId: 'recording-1',
    name: 'Take one',
    destination: 'library'
  }

  it('defaults to keeping the take whole', () => {
    // An older renderer, or any commit that says nothing, must not start splitting takes.
    const parsed = RecordingCommitPayloadSchema.safeParse(base)
    expect(parsed.success && parsed.data.splitChannels).toBe(false)
    expect(parsed.success && parsed.data.splitAsStereo).toBe(false)
  })

  it('carries the ids for the second half', () => {
    const parsed = RecordingCommitPayloadSchema.safeParse({
      ...base,
      destination: 'timeline',
      clipId: 'clip-1',
      splitChannels: true,
      splitAsStereo: true,
      secondItemId: 'recording-2',
      secondClipId: 'clip-2'
    })
    expect(parsed.success && parsed.data.secondItemId).toBe('recording-2')
    expect(parsed.success && parsed.data.secondClipId).toBe('clip-2')
  })
})