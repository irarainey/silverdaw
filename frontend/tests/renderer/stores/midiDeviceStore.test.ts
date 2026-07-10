import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'
import { send as sendBridge } from '@/lib/bridgeService'
import type { MidiInputDevice } from '@shared/bridge-protocol'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))

function input(identifier: string, overrides: Partial<MidiInputDevice> = {}): MidiInputDevice {
  return {
    name: identifier,
    identifier,
    connected: true,
    enabled: false,
    controllerProfile: null,
    lastActivityMs: null,
    ...overrides
  }
}

describe('midiDeviceStore', () => {
  const setMidiDeckSelection = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      silverdaw: {
        setMidiDeckSelection
      }
    })
  })

  it('starts empty and un-hydrated', () => {
    const store = useMidiDeviceStore()
    expect(store.inputs).toEqual([])
    expect(store.hydrated).toBe(false)
  })

  it('mirrors the input list and marks itself hydrated on applyList', () => {
    const store = useMidiDeviceStore()
    store.applyList({ inputs: [input('launchkey'), input('keystation', { enabled: true })] })
    expect(store.inputs).toEqual([input('launchkey'), input('keystation', { enabled: true })])
    expect(store.hydrated).toBe(true)
  })

  it('copies the payload array so later mutation does not leak back', () => {
    const store = useMidiDeviceStore()
    const payload = { inputs: [input('device-a')] }
    store.applyList(payload)
    payload.inputs.push(input('device-b'))
    expect(store.inputs).toEqual([input('device-a')])
  })

  it('replaces the list on a subsequent applyList', () => {
    const store = useMidiDeviceStore()
    store.applyList({ inputs: [input('device-a')] })
    store.applyList({ inputs: [] })
    expect(store.inputs).toEqual([])
    expect(store.hydrated).toBe(true)
  })

  it('sends MIDI_DEVICES_REQUEST when requestList is called', () => {
    const store = useMidiDeviceStore()
    store.requestList()
    expect(sendBridge).toHaveBeenCalledWith('MIDI_DEVICES_REQUEST')
  })

  it('applies a session-only input change through the bridge', () => {
    const store = useMidiDeviceStore()
    store.applyList({
      inputs: [input('launchkey', { controllerProfile: 'MIDI deck' })]
    })
    store.setInputEnabledForSession('launchkey', true)

    expect(store.enabledByIdentifier).toEqual({ launchkey: true })
    expect(sendBridge).toHaveBeenCalledWith('MIDI_INPUTS_SET', {
      identifiers: ['launchkey']
    })
  })

  it('keeps unsupported MIDI inputs visible but refuses to enable them', () => {
    const store = useMidiDeviceStore()
    store.applyList({ inputs: [input('keyboard', { controllerProfile: null })] })

    store.setInputEnabledForSession('keyboard', true)

    expect(store.inputs).toHaveLength(1)
    expect(store.enabledByIdentifier).toEqual({})
    expect(sendBridge).not.toHaveBeenCalledWith('MIDI_INPUTS_SET', expect.anything())
  })

  it('restores persisted deck selection after enabling its MIDI input', async () => {
    vi.stubGlobal('window', {
      silverdaw: {
        getEnabledMidiInputs: vi.fn().mockResolvedValue({ 'ddj-rb': true }),
        getMidiDeckSelections: vi.fn().mockResolvedValue({
          'ddj-rb': { deck1Enabled: false, deck2Enabled: true }
        }),
        setMidiDeckSelection
      }
    })
    const store = useMidiDeviceStore()

    await store.applyEnabledInputsOnReady()

    expect(sendBridge).toHaveBeenCalledWith('MIDI_INPUTS_SET', {
      identifiers: ['ddj-rb']
    })
    expect(sendBridge).toHaveBeenCalledWith('MIDI_DECK_SELECTION_SET', {
      deviceIdentifier: 'ddj-rb',
      deck1Enabled: false,
      deck2Enabled: true
    })
  })

  it('persists deck selection updates from the backend', () => {
    const store = useMidiDeviceStore()
    store.applyDeckSelection({
      deviceIdentifier: 'ddj-rb',
      deck1Enabled: true,
      deck2Enabled: false
    })

    expect(store.deckSelectionByIdentifier['ddj-rb']).toEqual({
      deck1Enabled: true,
      deck2Enabled: false
    })
    expect(setMidiDeckSelection).toHaveBeenCalledWith('ddj-rb', {
      deck1Enabled: true,
      deck2Enabled: false
    })
  })

  it('keeps the rescan state until the refreshed list arrives', () => {
    const store = useMidiDeviceStore()
    vi.mocked(sendBridge).mockReturnValue(true)

    store.requestRescan()

    expect(store.rescanning).toBe(true)
    expect(sendBridge).toHaveBeenCalledWith('MIDI_DEVICES_REQUEST')

    store.applyList({ inputs: [input('launchkey')] })
    expect(store.rescanning).toBe(false)
  })

  it('clears the rescan state immediately when the bridge is unavailable', () => {
    const store = useMidiDeviceStore()
    vi.mocked(sendBridge).mockReturnValue(false)

    store.requestRescan()

    expect(store.rescanning).toBe(false)
  })

  it('tracks mapped Shift, Sync, jog touch, and reserved crossfader state', () => {
    const store = useMidiDeviceStore()
    store.applyControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 1,
      kind: 'button',
      control: 'shift',
      deck: 2,
      pressed: true
    })
    store.applyControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 2,
      kind: 'button',
      control: 'syncModifier',
      deck: 2,
      pressed: true
    })
    store.applyControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 3,
      kind: 'button',
      control: 'jogTouch',
      deck: 1,
      pressed: true
    })
    store.applyControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 4,
      kind: 'absolute',
      control: 'crossfader',
      deck: null,
      value: 0.75
    })
    store.applyControl({
      deviceIdentifier: 'ddj-rb',
      timestampMs: 5,
      kind: 'absolute',
      control: 'masterVolume',
      deck: null,
      value: 0.25
    })

    expect(store.shiftPressed[2]).toBe(true)
    expect(store.syncPressed[2]).toBe(true)
    expect(store.jogTouched[1]).toBe(true)
    expect(store.crossfaderPosition).toBe(0.75)
  })
})
