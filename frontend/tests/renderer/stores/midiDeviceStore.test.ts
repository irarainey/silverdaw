import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'
import { send as sendBridge } from '@/lib/bridgeService'
import {
  handleMidiJogTouch,
  resetMidiPlaybackHoldForTests
} from '@/lib/midi/midiPlaybackHold'
import { useTransportStore } from '@/stores/transportStore'
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
    manufacturer: null,
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
    vi.mocked(sendBridge).mockReturnValue(true)
    resetMidiPlaybackHoldForTests()
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
        getMidiDevicePreferences: vi.fn().mockResolvedValue({
          'ddj-rb': {
            scrubAudioEnabled: false,
            crossfaderDirection: 'rightToLeft'
          }
        }),
        setMidiDeckSelection
      }
    })
    const store = useMidiDeviceStore()

    await store.applyEnabledInputsOnReady()

    expect(sendBridge).toHaveBeenCalledWith('MIDI_INPUTS_SET', {
      identifiers: ['ddj-rb']
    })
    expect(sendBridge).not.toHaveBeenCalledWith('MIDI_DECK_SELECTION_SET', expect.anything())

    store.applyList({
      inputs: [input('ddj-rb', { enabled: true, controllerProfile: 'MIDI deck' })]
    })

    expect(sendBridge).toHaveBeenCalledWith('MIDI_DECK_SELECTION_SET', {
      deviceIdentifier: 'ddj-rb',
      deck1Enabled: false,
      deck2Enabled: true
    })
    expect(store.isScrubAudioEnabled('ddj-rb')).toBe(false)
    expect(store.devicePreferencesByIdentifier['ddj-rb']?.crossfaderDirection)
      .toBe('rightToLeft')
  })

  it('applies the Default deck preference when a device has no saved selection', async () => {
    vi.stubGlobal('window', {
      silverdaw: {
        getEnabledMidiInputs: vi.fn().mockResolvedValue({ 'ddj-rb': true }),
        getMidiDeckSelections: vi.fn().mockResolvedValue({}),
        getMidiDevicePreferences: vi.fn().mockResolvedValue({
          'ddj-rb': {
            scrubAudioEnabled: false,
            crossfaderDirection: 'leftToRight',
            defaultDeck: 'deck1'
          }
        }),
        setMidiDeckSelection
      }
    })
    const store = useMidiDeviceStore()

    await store.applyEnabledInputsOnReady()
    store.applyList({
      inputs: [input('ddj-rb', { enabled: true, controllerProfile: 'MIDI deck' })]
    })

    expect(sendBridge).toHaveBeenCalledWith('MIDI_DECK_SELECTION_SET', {
      deviceIdentifier: 'ddj-rb',
      deck1Enabled: true,
      deck2Enabled: false
    })
    // The preference-derived selection is live but never persisted, so the
    // preference re-applies on every startup until the cue button saves one.
    expect(store.deckSelectionByIdentifier['ddj-rb']).toEqual({
      deck1Enabled: true,
      deck2Enabled: false
    })
    expect(setMidiDeckSelection).not.toHaveBeenCalled()
  })

  it('leaves decks deselected when Default deck is none and nothing is saved', async () => {
    vi.stubGlobal('window', {
      silverdaw: {
        getEnabledMidiInputs: vi.fn().mockResolvedValue({ 'ddj-rb': true }),
        getMidiDeckSelections: vi.fn().mockResolvedValue({}),
        getMidiDevicePreferences: vi.fn().mockResolvedValue({
          'ddj-rb': {
            scrubAudioEnabled: false,
            crossfaderDirection: 'leftToRight',
            defaultDeck: 'none'
          }
        }),
        setMidiDeckSelection
      }
    })
    const store = useMidiDeviceStore()

    await store.applyEnabledInputsOnReady()
    store.applyList({
      inputs: [input('ddj-rb', { enabled: true, controllerProfile: 'MIDI deck' })]
    })

    expect(sendBridge).not.toHaveBeenCalledWith('MIDI_DECK_SELECTION_SET', expect.anything())
    expect(store.deckSelectionByIdentifier['ddj-rb']).toBeUndefined()
  })

  it('prefers a saved cue selection over the Default deck preference', async () => {
    vi.stubGlobal('window', {
      silverdaw: {
        getEnabledMidiInputs: vi.fn().mockResolvedValue({ 'ddj-rb': true }),
        getMidiDeckSelections: vi.fn().mockResolvedValue({
          'ddj-rb': { deck1Enabled: false, deck2Enabled: true }
        }),
        getMidiDevicePreferences: vi.fn().mockResolvedValue({
          'ddj-rb': {
            scrubAudioEnabled: false,
            crossfaderDirection: 'leftToRight',
            defaultDeck: 'deck1'
          }
        }),
        setMidiDeckSelection
      }
    })
    const store = useMidiDeviceStore()

    await store.applyEnabledInputsOnReady()
    store.applyList({
      inputs: [input('ddj-rb', { enabled: true, controllerProfile: 'MIDI deck' })]
    })

    expect(sendBridge).toHaveBeenCalledWith('MIDI_DECK_SELECTION_SET', {
      deviceIdentifier: 'ddj-rb',
      deck1Enabled: false,
      deck2Enabled: true
    })
  })

  it('does not send saved deck selection to a disconnected historical identifier', async () => {
    vi.stubGlobal('window', {
      silverdaw: {
        getEnabledMidiInputs: vi.fn().mockResolvedValue({
          current: true,
          historical: true
        }),
        getMidiDeckSelections: vi.fn().mockResolvedValue({
          current: { deck1Enabled: true, deck2Enabled: false },
          historical: { deck1Enabled: false, deck2Enabled: true }
        }),
        getMidiDevicePreferences: vi.fn().mockResolvedValue({}),
        setMidiDeckSelection
      }
    })
    const store = useMidiDeviceStore()

    await store.applyEnabledInputsOnReady()
    store.applyList({
      inputs: [input('current', { enabled: true, controllerProfile: 'MIDI deck' })]
    })

    expect(sendBridge).toHaveBeenCalledWith('MIDI_DECK_SELECTION_SET', {
      deviceIdentifier: 'current',
      deck1Enabled: true,
      deck2Enabled: false
    })
    expect(sendBridge).not.toHaveBeenCalledWith('MIDI_DECK_SELECTION_SET', {
      deviceIdentifier: 'historical',
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

  it('defaults timeline scrub audio off for devices without an override', () => {
    const store = useMidiDeviceStore()
    expect(store.isScrubAudioEnabled('new-controller')).toBe(false)
    store.applyDevicePreferences({
      'new-controller': {
        scrubAudioEnabled: true,
        crossfaderDirection: 'leftToRight',
        defaultDeck: 'none'
      }
    })
    expect(store.isScrubAudioEnabled('new-controller')).toBe(true)
  })

  it('resumes a held transport when the touched deck is disabled', () => {
    const transport = useTransportStore()
    transport.setPlaybackState(true)
    handleMidiJogTouch('ddj-rb', 2, true)
    vi.mocked(sendBridge).mockClear()

    useMidiDeviceStore().applyDeckSelection({
      deviceIdentifier: 'ddj-rb',
      deck1Enabled: true,
      deck2Enabled: false
    })

    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_PLAY')
    expect(transport.isPlaybackHeld).toBe(false)
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

  it('sends MIDI_SCRATCH_SETTINGS_SET on hydrate for devices with direction preferences', async () => {
    vi.stubGlobal('window', {
      silverdaw: {
        getEnabledMidiInputs: vi.fn().mockResolvedValue({ 'ddj-rb': true }),
        getMidiDeckSelections: vi.fn().mockResolvedValue({}),
        getMidiDevicePreferences: vi.fn().mockResolvedValue({
          'ddj-rb': {
            scrubAudioEnabled: false,
            crossfaderDirection: 'rightToLeft'
          }
        }),
        setMidiDeckSelection
      }
    })
    const store = useMidiDeviceStore()
    await store.applyEnabledInputsOnReady()

    expect(sendBridge).toHaveBeenCalledWith('MIDI_SCRATCH_SETTINGS_SET', {
      deviceIdentifier: 'ddj-rb',
      crossfaderDirection: 'rightToLeft'
    })
  })

  it('sends MIDI_SCRATCH_SETTINGS_SET when device preferences are applied', () => {
    const store = useMidiDeviceStore()
    store.applyDevicePreferences({
      'ddj-rb': {
        scrubAudioEnabled: true,
        crossfaderDirection: 'rightToLeft',
        defaultDeck: 'none'
      }
    })

    expect(sendBridge).toHaveBeenCalledWith('MIDI_SCRATCH_SETTINGS_SET', {
      deviceIdentifier: 'ddj-rb',
      crossfaderDirection: 'rightToLeft'
    })
  })

  it('sends MIDI_SCRATCH_SETTINGS_SET with leftToRight for default direction', () => {
    const store = useMidiDeviceStore()
    store.applyDevicePreferences({
      controller: {
        scrubAudioEnabled: false,
        crossfaderDirection: 'leftToRight',
        defaultDeck: 'none'
      }
    })

    expect(sendBridge).toHaveBeenCalledWith('MIDI_SCRATCH_SETTINGS_SET', {
      deviceIdentifier: 'controller',
      crossfaderDirection: 'leftToRight'
    })
  })
})
