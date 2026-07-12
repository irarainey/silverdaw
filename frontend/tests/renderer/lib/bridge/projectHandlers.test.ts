import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectBridgeHandlers } from '@/lib/bridge/handlers/projectHandlers'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useBackspinSettingsStore } from '@/stores/backspinSettingsStore'
import { useBrakeSettingsStore } from '@/stores/brakeSettingsStore'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import type { ProjectStatePayload } from '@shared/bridge-protocol'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))
vi.mock('@/lib/engineRecovery', () => ({
  onProjectStateApplied: vi.fn()
}))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const emptySnapshot: ProjectStatePayload = {
  filePath: null,
  name: 'Untitled',
  tracks: []
}

describe('project bridge handlers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('re-applies backend-scoped preferences only once per bridge connection', () => {
    const audioDevices = useAudioDeviceStore()
    const midiDevices = useMidiDeviceStore()
    const brakeSettings = useBrakeSettingsStore()
    const backspinSettings = useBackspinSettingsStore()
    const ui = useUiStore()
    const requestAudioDevices = vi.spyOn(audioDevices, 'requestInitialList').mockImplementation(() => {})
    const applyKeepAwake = vi.spyOn(audioDevices, 'applyKeepAwakeOnReady').mockResolvedValue()
    const applyMidiInputs = vi.spyOn(midiDevices, 'applyEnabledInputsOnReady').mockResolvedValue()
    const applyBrake = vi.spyOn(brakeSettings, 'applyBrakeSettingsOnReady').mockResolvedValue()
    const applyBackspin = vi.spyOn(backspinSettings, 'applyBackspinSettingsOnReady').mockResolvedValue()
    const syncSeedTempo = vi.spyOn(ui, 'syncSeedTempoPrefToBackend').mockImplementation(() => {})

    projectBridgeHandlers.PROJECT_STATE(emptySnapshot)
    projectBridgeHandlers.PROJECT_STATE(emptySnapshot)

    expect(requestAudioDevices).toHaveBeenCalledTimes(1)
    expect(applyKeepAwake).toHaveBeenCalledTimes(1)
    expect(applyMidiInputs).toHaveBeenCalledTimes(1)
    expect(applyBrake).toHaveBeenCalledTimes(1)
    expect(applyBackspin).toHaveBeenCalledTimes(1)
    expect(syncSeedTempo).toHaveBeenCalledTimes(1)

    useTransportStore().setConnected(false)
    projectBridgeHandlers.PROJECT_STATE(emptySnapshot)

    expect(requestAudioDevices).toHaveBeenCalledTimes(2)
    expect(applyMidiInputs).toHaveBeenCalledTimes(2)
  })

  it('clears transient MIDI playback holds on a project snapshot', () => {
    const transport = useTransportStore()
    transport.setPlaybackState(true)
    transport.beginMidiPlaybackHold('ddj-rb:2')

    projectBridgeHandlers.PROJECT_STATE(emptySnapshot)

    expect(transport.isPlaying).toBe(false)
    expect(transport.midiPlaybackHoldActive).toBe(false)
    expect(transport.midiPlaybackHoldSources).toEqual([])
  })
})
