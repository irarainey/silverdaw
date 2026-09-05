import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useRecordingSession } from '@/lib/recording/useRecordingSession'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'
import { useTransportStore } from '@/stores/transportStore'
import { send as sendBridge } from '@/lib/bridgeService'
import type { RecordingReadyPayload, RecordingSessionStatePayload } from '@shared/bridge-protocol'
import {
  MAX_RECORDING_INPUT_GAIN_DB,
  MIN_RECORDING_INPUT_GAIN_DB
} from '@shared/bridge-protocol'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const setAudioInput = vi.fn()

function makeState(
  overrides: Partial<RecordingSessionStatePayload> = {}
): RecordingSessionStatePayload {
  return {
    protocolVersion: 1,
    sessionId: 'session-1',
    status: 'idle',
    input: {
      typeName: 'Windows Audio',
      deviceName: 'USB Mic',
      channelNames: ['In 1', 'In 2'],
      sampleRate: 48000,
      inputLatencyMs: 10
    },
    firstChannel: 0,
    channelCount: 1,
    countInBars: 0,
    clickEnabled: false,
    inputGainDb: 0,
    windowMode: 'playhead',
    hasSelection: false,
    anchorMs: 0,
    windowEndMs: null,
    recordedMs: 0,
    droppedSamples: 0,
    ...overrides
  }
}

function makeReady(): RecordingReadyPayload {
  return {
    protocolVersion: 1,
    sessionId: 'session-1',
    recordingId: 'capture-1',
    filePath: 'C:/project/recordings/Recording 1.wav',
    suggestedName: 'Recording 1',
    durationMs: 4000,
    sampleRate: 48000,
    channelCount: 1,
    anchorMs: 2000,
    bpm: 120,
    beatAnchorSec: 0,
    cachePath: 'C:/cache/rec.peaks',
    peakCount: 400,
    peaksPerSecond: 100,
    latencyOffsetMs: 20,
    driftPpm: 4.5,
    droppedSamples: 0
  }
}

function sentEnvelopes(): string[] {
  return vi.mocked(sendBridge).mock.calls.map((call) => call[0] as string)
}

describe('useRecordingSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(sendBridge).mockClear()
    // The real client reports a queued-while-disconnected send with `false`, and
    // the rescan spinner depends on knowing the request went out.
    vi.mocked(sendBridge).mockReturnValue(true)
    setAudioInput.mockClear()
    vi.stubGlobal('window', {
      silverdaw: { setAudioInput },
      crypto: globalThis.crypto
    })
  })

  it('opens the backend session when the dialog opens and closes it when it goes', async () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    const scope = effectScope()
    scope.run(() => useRecordingSession(open))

    expect(sentEnvelopes()).toEqual(['RECORD_INPUTS_REQUEST', 'RECORD_SESSION_OPEN'])

    store.applyState(makeState())
    open.value = false
    await nextTick()

    expect(sentEnvelopes()).toContain('RECORD_SESSION_CLOSE')
    expect(store.current).toBeNull()
    scope.stop()
  })

  it('reuses the cached input list on the next open, and rescans only on request', async () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    const scope = effectScope()
    const session = scope.run(() => useRecordingSession(open))!

    store.applyInputs({ types: [{ name: 'Windows Audio', devices: ['Microphone'] }] })
    open.value = false
    await nextTick()
    vi.mocked(sendBridge).mockClear()

    // Enumerating every driver is slow, so a second open must show the list it
    // already has rather than making the dialog wait for another scan.
    open.value = true
    await nextTick()
    expect(sentEnvelopes()).not.toContain('RECORD_INPUTS_REQUEST')

    session.rescanInputs()
    const rescan = vi.mocked(sendBridge).mock.calls.find((call) => call[0] === 'RECORD_INPUTS_REQUEST')
    expect(rescan?.[1]).toEqual({ refresh: true })
    expect(store.rescanningInputs).toBe(true)

    // The refreshed list is what ends the spinner.
    store.applyInputs({ types: [{ name: 'Windows Audio', devices: ['Microphone', 'Interface'] }] })
    expect(store.rescanningInputs).toBe(false)
    scope.stop()
  })

  it('clamps the input gain to the range the backend accepts', () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    const scope = effectScope()
    const session = scope.run(() => useRecordingSession(open))!

    store.applyState(makeState())
    session.setInputGain(100)
    session.setInputGain(-100)

    const gains = vi
      .mocked(sendBridge)
      .mock.calls.filter((call) => call[0] === 'RECORD_SESSION_CONTROL')
      .map((call) => call[1] as { action: string; gainDb: number })
      .filter((payload) => payload.action === 'setInputGain')
      .map((payload) => payload.gainDb)
    expect(gains).toEqual([MAX_RECORDING_INPUT_GAIN_DB, MIN_RECORDING_INPUT_GAIN_DB])
    scope.stop()
  })

  it('re-applies the remembered input gain as soon as a session opens', async () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    store.rememberedInputGainDb = -6
    const scope = effectScope()
    scope.run(() => useRecordingSession(open))

    store.applyState(makeState())
    await nextTick()

    const applied = vi
      .mocked(sendBridge)
      .mock.calls.filter((call) => call[0] === 'RECORD_SESSION_CONTROL')
      .map((call) => call[1] as { action: string; gainDb?: number })
      .find((payload) => payload.action === 'setInputGain')
    expect(applied?.gainDb).toBe(-6)
    // Re-applying what was already remembered must not write the gain preference back.
    expect(setAudioInput).not.toHaveBeenCalledWith(
      expect.objectContaining({ gainDb: expect.anything() })
    )
    scope.stop()
  })

  it('remembers a gain the user sets so it survives the dialog closing', () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    const scope = effectScope()
    const session = scope.run(() => useRecordingSession(open))!

    store.applyState(makeState())
    session.setInputGain(-3.5)

    expect(store.rememberedInputGainDb).toBe(-3.5)
    expect(setAudioInput).toHaveBeenCalledWith({ gainDb: -3.5 })
    scope.stop()
  })

  it('ignores state from a session it has already closed', async () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    const scope = effectScope()
    scope.run(() => useRecordingSession(open))

    store.applyState(makeState())
    open.value = false
    await nextTick()

    store.applyState(makeState({ status: 'recording', recordedMs: 1200 }))
    expect(store.current).toBeNull()
    scope.stop()
  })

  it('closes a session whose first state arrives after the dialog has gone', async () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    const scope = effectScope()
    scope.run(() => useRecordingSession(open))

    open.value = false
    await nextTick()
    vi.mocked(sendBridge).mockClear()

    store.applyState(makeState({ sessionId: 'late-session' }))
    await nextTick()

    const close = vi
      .mocked(sendBridge)
      .mock.calls.find((call) => call[0] === 'RECORD_SESSION_CLOSE')
    expect(close?.[1]).toMatchObject({ sessionId: 'late-session' })
    scope.stop()
  })

  it('remembers the device the session resolved to, and leaves the driver to Preferences', async () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    store.preferredInputTypeName = 'ASIO'
    const scope = effectScope()
    const session = scope.run(() => useRecordingSession(open))!

    store.applyState(makeState())
    session.selectInput({ typeName: 'ASIO', deviceName: 'Interface' })
    await nextTick()

    // The backend answered with the device it managed to open, so that is what is
    // remembered — a device that failed to open must not come back next time. The
    // driver written back is the one pinned in Preferences, not the resolved one.
    expect(setAudioInput).toHaveBeenCalledTimes(1)
    expect(setAudioInput).toHaveBeenCalledWith({
      typeName: 'ASIO',
      deviceName: 'USB Mic'
    })
    expect(store.rememberedInput).toEqual({ typeName: 'Windows Audio', deviceName: 'USB Mic' })
    scope.stop()
  })

  it('commits with a renderer-generated item id, and a clip id only for the timeline', () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    const scope = effectScope()
    const session = scope.run(() => useRecordingSession(open))!

    store.applyState(makeState({ status: 'review' }))
    store.applyRecordingReady(makeReady())

    const libraryItemId = session.commit({ name: 'Take one', destination: 'library' })
    expect(libraryItemId).not.toBeNull()
    expect(store.commitPendingItemId).toBe(libraryItemId)
    const libraryCommit = vi
      .mocked(sendBridge)
      .mock.calls.find((call) => call[0] === 'RECORD_RECORDING_COMMIT')?.[1] as Record<
      string,
      unknown
    >
    expect(libraryCommit.clipId).toBeUndefined()
    expect(libraryCommit.recordingId).toBe('capture-1')

    vi.mocked(sendBridge).mockClear()
    store.resolveCommit(libraryItemId!, false, 'disk full')
    session.commit({ name: 'Take one', destination: 'timeline' })
    const timelineCommit = vi
      .mocked(sendBridge)
      .mock.calls.find((call) => call[0] === 'RECORD_RECORDING_COMMIT')?.[1] as Record<
      string,
      unknown
    >
    expect(typeof timelineCommit.clipId).toBe('string')
    scope.stop()
  })

  it('refuses a second commit while one is still in flight', () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    const scope = effectScope()
    const session = scope.run(() => useRecordingSession(open))!

    store.applyState(makeState({ status: 'review' }))
    store.applyRecordingReady(makeReady())

    expect(session.commit({ name: 'Take one', destination: 'library' })).not.toBeNull()
    vi.mocked(sendBridge).mockClear()
    // A double click must not produce two library items and orphan the first ack.
    expect(session.commit({ name: 'Take one', destination: 'timeline' })).toBeNull()
    expect(sentEnvelopes()).not.toContain('RECORD_RECORDING_COMMIT')
    scope.stop()
  })

  it('does not revive a session destroyed by engine recovery', async () => {
    const open = ref(true)
    const store = useRecordingSessionStore()
    const transport = useTransportStore()
    const scope = effectScope()
    scope.run(() => useRecordingSession(open))

    store.applyState(makeState())
    transport.engineRecovery = 'recovering'
    await nextTick()
    expect(store.current).toBeNull()

    // A state message still in flight when the engine went down must not bring
    // the dead session back and strand the dialog on it.
    store.applyState(makeState({ status: 'recording' }))
    expect(store.current).toBeNull()

    vi.mocked(sendBridge).mockClear()
    transport.engineRecovery = 'ok'
    await nextTick()
    expect(sentEnvelopes()).toContain('RECORD_SESSION_OPEN')
    scope.stop()
  })
})
