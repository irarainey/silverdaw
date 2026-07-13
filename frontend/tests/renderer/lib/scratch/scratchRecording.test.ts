import { describe, expect, it, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import type {
  ScratchPatternRecordedPayload,
  ScratchSessionStatePayload
} from '@shared/bridge-protocol'
import {
  isScratchPatternRecordedPayload,
  ScratchPatternRecordedPayloadSchema
} from '@shared/bridge-protocol'
import {
  buildRecordStartPayload,
  buildRecordStopPayload
} from '@/lib/scratch/scratchControlHelpers'
import {
  createScratchSessionLifecycle
} from '@/lib/scratch/scratchSessionLifecycle'
import type {
  ScratchSessionClosePayload,
  ScratchSessionControlPayload,
  ScratchSessionOpenPayload
} from '@shared/bridge-protocol'

function makeState(
  overrides: Partial<ScratchSessionStatePayload> = {}
): ScratchSessionStatePayload {
  return {
    protocolVersion: 1,
    sessionId: 'session-1',
    clipId: 'clip-1',
    status: 'ready',
    positionUs: 0,
    durationUs: 2_000_000,
    platterTurns: 0,
    playbackRate: 0,
    crossfader: 0.5,
    ownerDeviceIdentifier: null,
    ownerDeck: null,
    touched: false,
    ...overrides
  }
}

function makeRecordedPayload(
  overrides: Partial<ScratchPatternRecordedPayload> = {}
): ScratchPatternRecordedPayload {
  return {
    protocolVersion: 1,
    sessionId: 'session-1',
    pattern: {
      id: 'draft-1',
      name: 'Test take',
      version: 1,
      durationUs: 1_000_000,
      cropStartUs: 0,
      cropEndUs: 1_000_000,
      sourceOffsetTurns: 0,
      ownerDeck: 1,
      crossfaderCurve: 'linear-v1',
      platter: [
        { timeUs: 0, turns: 0, touched: false },
        { timeUs: 1_000_000, turns: 0.5, touched: true }
      ],
      crossfader: [
        { timeUs: 0, value: 0 },
        { timeUs: 1_000_000, value: 0.8 }
      ],
      provenance: { sourceClipId: 'clip-1' }
    },
    ...overrides
  }
}

describe('scratch pattern recorded schema', () => {
  it('accepts a valid recorded pattern payload', () => {
    const payload = makeRecordedPayload()
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(true)
    expect(isScratchPatternRecordedPayload(payload)).toBe(true)
  })

  it('rejects wrong protocol version', () => {
    const payload = { ...makeRecordedPayload(), protocolVersion: 2 }
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('rejects missing sessionId', () => {
    const { sessionId: _, ...rest } = makeRecordedPayload()
    expect(ScratchPatternRecordedPayloadSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects invalid pattern within the payload', () => {
    const payload = makeRecordedPayload()
    payload.pattern.version = 2 as never
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(false)
  })
})

describe('scratch session store recording lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts in empty recording status', () => {
    const store = useScratchSessionStore()
    expect(store.recordingStatus).toBe('empty')
    expect(store.completedPattern).toBe(null)
  })

  it('transitions to recording on recording state', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ status: 'recording' }))
    expect(store.recordingStatus).toBe('recording')
  })

  it('transitions to completed on pattern received', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ status: 'recording' }))
    store.applyPatternRecorded(makeRecordedPayload())
    expect(store.recordingStatus).toBe('completed')
    expect(store.completedPattern).not.toBe(null)
    expect(store.completedPattern?.id).toBe('draft-1')
  })

  it('rejects pattern from wrong session', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ sessionId: 'session-1' }))
    store.applyPatternRecorded(makeRecordedPayload({ sessionId: 'session-2' }))
    expect(store.recordingStatus).toBe('empty')
    expect(store.completedPattern).toBe(null)
  })

  it('clears recording state on clear', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ status: 'recording' }))
    store.applyPatternRecorded(makeRecordedPayload())
    store.clear()
    expect(store.recordingStatus).toBe('empty')
    expect(store.completedPattern).toBe(null)
    expect(store.current).toBe(null)
  })

  it('clears recording without full clear', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ status: 'recording' }))
    store.applyPatternRecorded(makeRecordedPayload())
    store.clearRecording()
    expect(store.recordingStatus).toBe('empty')
    expect(store.completedPattern).toBe(null)
    expect(store.current).not.toBe(null)
  })
})

describe('scratch recording control helpers', () => {
  it('builds a recordStart payload', () => {
    const payload = buildRecordStartPayload('session-1')
    expect(payload.protocolVersion).toBe(1)
    expect(payload.sessionId).toBe('session-1')
    expect(payload.action).toBe('recordStart')
  })

  it('builds a recordStop payload', () => {
    const payload = buildRecordStopPayload('session-1')
    expect(payload.protocolVersion).toBe(1)
    expect(payload.sessionId).toBe('session-1')
    expect(payload.action).toBe('recordStop')
  })
})

describe('scratch session lifecycle recording', () => {
  function setup() {
    const open = vi.fn<(payload: ScratchSessionOpenPayload) => void>()
    const close = vi.fn<(payload: ScratchSessionClosePayload) => void>()
    const control = vi.fn<(payload: ScratchSessionControlPayload) => void>()
    const clearState = vi.fn()
    return {
      lifecycle: createScratchSessionLifecycle({ open, close, control, clearState }),
      open,
      close,
      control,
      clearState
    }
  }

  it('dispatches recordStart and recordStop via toggleRecording', () => {
    const { lifecycle, control } = setup()
    lifecycle.open('clip-1')
    lifecycle.consume(makeState({ status: 'ready' }))

    lifecycle.toggleRecording()
    expect(control).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      sessionId: 'session-1',
      action: 'recordStart'
    })

    lifecycle.consume(makeState({ status: 'recording' }))
    lifecycle.toggleRecording()
    expect(control).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      sessionId: 'session-1',
      action: 'recordStop'
    })
  })

  it('does not dispatch recording without an active session', () => {
    const { lifecycle, control } = setup()
    lifecycle.toggleRecording()
    expect(control).not.toHaveBeenCalled()
  })

  it('dispatches recordArm, recordDisarm and recordStop via arming primitives', () => {
    const { lifecycle, control } = setup()
    lifecycle.open('clip-1')
    lifecycle.consume(makeState({ status: 'ready' }))

    lifecycle.armRecording()
    expect(control).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      sessionId: 'session-1',
      action: 'recordArm'
    })

    lifecycle.disarmRecording()
    expect(control).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      sessionId: 'session-1',
      action: 'recordDisarm'
    })

    lifecycle.stopRecording()
    expect(control).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      sessionId: 'session-1',
      action: 'recordStop'
    })
  })

  it('does not dispatch arming without an active session', () => {
    const { lifecycle, control } = setup()
    lifecycle.armRecording()
    lifecycle.disarmRecording()
    lifecycle.stopRecording()
    expect(control).not.toHaveBeenCalled()
  })
})

describe('scratch pattern validation', () => {
  it('rejects empty platter lane', () => {
    const payload = makeRecordedPayload()
    payload.pattern.platter = []
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('rejects empty crossfader lane', () => {
    const payload = makeRecordedPayload()
    payload.pattern.crossfader = []
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('rejects platter lane not starting at timestamp 0', () => {
    const payload = makeRecordedPayload()
    payload.pattern.platter = [
      { timeUs: 100, turns: 0, touched: false },
      { timeUs: 1_000_000, turns: 0.5, touched: true }
    ]
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('rejects platter lane not ending at durationUs', () => {
    const payload = makeRecordedPayload()
    payload.pattern.platter = [
      { timeUs: 0, turns: 0, touched: false },
      { timeUs: 500_000, turns: 0.5, touched: true }
    ]
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('rejects crossfader lane not starting at timestamp 0', () => {
    const payload = makeRecordedPayload()
    payload.pattern.crossfader = [
      { timeUs: 100, value: 0 },
      { timeUs: 1_000_000, value: 0.8 }
    ]
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('rejects crossfader lane not ending at durationUs', () => {
    const payload = makeRecordedPayload()
    payload.pattern.crossfader = [
      { timeUs: 0, value: 0 },
      { timeUs: 500_000, value: 0.8 }
    ]
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(false)
  })

  it('accepts zero-duration pattern with single-point lanes', () => {
    const payload = makeRecordedPayload()
    payload.pattern.durationUs = 0
    payload.pattern.cropEndUs = 0
    payload.pattern.platter = [{ timeUs: 0, turns: 0, touched: false }]
    payload.pattern.crossfader = [{ timeUs: 0, value: 0 }]
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('rejects zero-duration pattern with multiple points', () => {
    const payload = makeRecordedPayload()
    payload.pattern.durationUs = 0
    payload.pattern.cropEndUs = 0
    payload.pattern.platter = [
      { timeUs: 0, turns: 0, touched: false },
      { timeUs: 0, turns: 0.1, touched: true }
    ]
    expect(ScratchPatternRecordedPayloadSchema.safeParse(payload).success).toBe(false)
  })
})

describe('scratch session store acceptance requires exact session ID', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('rejects pattern when no current session', () => {
    const store = useScratchSessionStore()
    store.applyPatternRecorded(makeRecordedPayload())
    expect(store.recordingStatus).toBe('empty')
    expect(store.completedPattern).toBe(null)
  })

  it('rejects pattern when current session has different ID', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ sessionId: 'session-X' }))
    store.applyPatternRecorded(makeRecordedPayload({ sessionId: 'session-Y' }))
    expect(store.recordingStatus).toBe('empty')
    expect(store.completedPattern).toBe(null)
  })

  it('accepts pattern when current session ID matches exactly', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ sessionId: 'session-1' }))
    store.applyPatternRecorded(makeRecordedPayload({ sessionId: 'session-1' }))
    expect(store.recordingStatus).toBe('completed')
    expect(store.completedPattern).not.toBe(null)
  })
})
