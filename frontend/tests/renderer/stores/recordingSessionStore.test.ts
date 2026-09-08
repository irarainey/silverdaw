import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import type { RecordingInputsListPayload } from '@shared/bridge-protocol'
import type { LatencyCalibrationDto } from '@shared/types'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))

vi.mock('@/lib/log', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  }
}))

describe('recordingSessionStore.hasNoInput', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('says nothing yet before the listing arrives', () => {
    const store = useRecordingSessionStore()
    store.inputs = null
    expect(store.hasNoInput).toBe(false)
  })

  it('reports no input when no driver exposes a device', () => {
    const store = useRecordingSessionStore()
    store.inputs = {
      types: [{ name: 'Windows Audio', devices: [] }]
    } as RecordingInputsListPayload
    expect(store.hasNoInput).toBe(true)
  })

  // Windows exposes alias endpoints that stand for "whatever the default is". They are
  // filtered out of the picker, so a machine with only those has nothing to choose: the
  // dialog must say so rather than show an empty, disabled picker with no explanation.
  it('reports no input when the only devices are Windows pseudo endpoints', () => {
    const store = useRecordingSessionStore()
    store.inputs = {
      types: [
        { name: 'Windows Audio', devices: ['Primary Sound Capture Driver'] },
        { name: 'DirectSound', devices: ['Microsoft Sound Mapper'] }
      ]
    } as RecordingInputsListPayload
    expect(store.hasNoInput).toBe(true)
  })

  it('reports an input once a real device is listed alongside the pseudo ones', () => {
    const store = useRecordingSessionStore()
    store.inputs = {
      types: [
        { name: 'Windows Audio', devices: ['Primary Sound Capture Driver', 'Microphone (USB)'] }
      ]
    } as RecordingInputsListPayload
    expect(store.hasNoInput).toBe(false)
  })
})

// Latency calibration (ADR 0030, Amendment 17). The round trip belongs to the input and the
// output together, so everything here turns on the pair being resolved before a stored figure
// is claimed to apply.
describe('recordingSessionStore latency calibration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('window', {
      ...globalThis.window,
      silverdaw: { setLatencyCalibration: vi.fn(), getLatencyCalibrations: vi.fn() }
    })
  })

  function openSession(deviceName: string, sampleRate = 48000): void {
    const store = useRecordingSessionStore()
    store.current = {
      sessionId: 'session-1',
      status: 'idle',
      input: { deviceName, sampleRate, inputLatencyMs: 18 }
    } as never
    useAudioDeviceStore().currentDeviceName = 'Speakers (USB DAC)'
  }

  it('has no key until an input is open, so nothing claims to be calibrated', () => {
    const store = useRecordingSessionStore()
    store.calibrations = { anything: makeCalibration(96) }
    expect(store.activeCalibrationKey).toBeNull()
    expect(store.activeCalibration).toBeNull()
  })

  it('resolves the calibration stored for this input and output pair', () => {
    const store = useRecordingSessionStore()
    openSession('Microphone (USB)')
    const key = store.activeCalibrationKey
    expect(key).not.toBeNull()
    store.calibrations = { [key as string]: makeCalibration(96) }
    expect(store.activeCalibration?.roundTripMs).toBe(96)
  })

  // The same microphone through a different output is a different round trip, so a figure
  // measured against one output must not be reused for another.
  it('does not reuse a calibration when the output device changes', () => {
    const store = useRecordingSessionStore()
    openSession('Microphone (USB)')
    store.calibrations = { [store.activeCalibrationKey as string]: makeCalibration(96) }
    useAudioDeviceStore().currentDeviceName = 'Speakers (Laptop)'
    expect(store.activeCalibration).toBeNull()
  })

  it('flags a measurement taken at a different sample rate as worth repeating', () => {
    const store = useRecordingSessionStore()
    openSession('Microphone (USB)', 44100)
    store.calibrations = {
      [store.activeCalibrationKey as string]: makeCalibration(96, { sampleRate: 48000 })
    }
    expect(store.isCalibrationStale).toBe(true)
  })

  // A typed figure has no sample rate behind it, so calling it stale would be telling the user
  // to re-measure something they deliberately set by hand.
  it('never calls a hand-entered figure stale', () => {
    const store = useRecordingSessionStore()
    openSession('Microphone (USB)', 44100)
    store.calibrations = {
      [store.activeCalibrationKey as string]: makeCalibration(96, { manual: true, sampleRate: 0 })
    }
    expect(store.isCalibrationStale).toBe(false)
  })

  it('stores an accepted measurement and tells the backend to trim by it', async () => {
    const { send } = await import('@/lib/bridgeService')
    const store = useRecordingSessionStore()
    openSession('Microphone (USB)')
    vi.mocked(send).mockClear()
    store.saveCalibration(96, false)

    expect(store.activeCalibration?.roundTripMs).toBe(96)
    expect(window.silverdaw.setLatencyCalibration).toHaveBeenCalledWith(
      store.activeCalibrationKey,
      expect.objectContaining({ roundTripMs: 96, manual: false })
    )
    expect(send).toHaveBeenCalledWith(
      'RECORD_SESSION_CONTROL',
      expect.objectContaining({ action: 'setCalibration', roundTripMs: 96 })
    )
  })

  // Clearing has to reach the backend too: leaving the old figure in the session would keep
  // trimming takes by a calibration the user has just thrown away.
  it('sends a null round trip when the calibration is cleared', async () => {
    const { send } = await import('@/lib/bridgeService')
    const store = useRecordingSessionStore()
    openSession('Microphone (USB)')
    store.saveCalibration(96, false)
    vi.mocked(send).mockClear()
    store.clearCalibration()

    expect(store.activeCalibration).toBeNull()
    expect(send).toHaveBeenCalledWith(
      'RECORD_SESSION_CONTROL',
      expect.objectContaining({ action: 'setCalibration', roundTripMs: null })
    )
  })

  it('keeps a stored calibration when a measurement run is abandoned', () => {
    const store = useRecordingSessionStore()
    openSession('Microphone (USB)')
    store.saveCalibration(96, false)
    store.calibrateStatus = 'measuring'
    store.resetCalibrationRun()

    expect(store.calibrateStatus).toBe('idle')
    expect(store.activeCalibration?.roundTripMs).toBe(96)
  })
})

describe('recordingSessionStore.isSetupLocked', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  function atStatus(status: string): boolean {
    const store = useRecordingSessionStore()
    store.current = { sessionId: 'session-1', status } as never
    return store.isSetupLocked
  }

  it('leaves the setup open before a take and after one is kept or discarded', () => {
    expect(atStatus('idle')).toBe(false)
    expect(atStatus('error')).toBe(false)
  })

  it('locks the setup while audio is being captured', () => {
    expect(atStatus('countIn')).toBe(true)
    expect(atStatus('recording')).toBe(true)
  })

  it('locks the setup while a take is still being written out', () => {
    // Finalising shows the setup pane rather than the review pane, so without this the
    // input picker is live and changing it re-arms the session under the take.
    expect(atStatus('finalising')).toBe(true)
  })
})

function makeCalibration(
  roundTripMs: number,
  overrides: Partial<LatencyCalibrationDto> = {}
): LatencyCalibrationDto {
  return {
    roundTripMs,
    manual: false,
    sampleRate: 48000,
    measuredAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}
