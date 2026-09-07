import { describe, expect, it } from 'vitest'
import { RecordingSessionStatePayloadSchema } from '@shared/bridge-protocol'

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
