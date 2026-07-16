// MIDI input device mirror. The backend owns enumeration, opening inputs, and activity.

import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type {
  MidiControlPayload,
  MidiDeckSelectionPayload,
  MidiDevicesListPayload,
  MidiInputDevice,
  MidiMessagePayload
} from '@shared/bridge-protocol'
import { DEFAULT_MIDI_DEVICE_PREFERENCES } from '@shared/types'
import type { MidiDeckSelection, MidiDefaultDeck, MidiDevicePreferences } from '@shared/types'
import {
  releaseMidiPlaybackHoldsForDeck,
  releaseMidiPlaybackHoldsForDevice
} from '@/lib/midi/midiPlaybackHold'

const RESCAN_SAFETY_MS = 6000
const MAX_MONITOR_MESSAGES = 200
let rescanSafetyTimer: ReturnType<typeof setTimeout> | null = null

/** Live deck selection a device auto-applies at startup for its Default deck preference. */
export function deckSelectionForDefault(defaultDeck: MidiDefaultDeck): MidiDeckSelection {
  return {
    deck1Enabled: defaultDeck === 'deck1',
    deck2Enabled: defaultDeck === 'deck2'
  }
}

interface MidiDeviceState {
  /** Connected MIDI input devices and their live backend state. */
  inputs: MidiInputDevice[]
  /** Persisted enabled inputs, keyed by JUCE device identifier. */
  enabledByIdentifier: Record<string, boolean>
  deckSelectionByIdentifier: Record<string, MidiDeckSelection>
  devicePreferencesByIdentifier: Record<string, MidiDevicePreferences>
  /** True after the first MIDI_DEVICES_LIST arrives. */
  hydrated: boolean
  /** Apply saved deck assignments after the backend confirms which inputs opened. */
  deckSelectionSyncPending: boolean
  /** True from a user-initiated rescan until the backend replies. */
  rescanning: boolean
  monitorMessages: MidiMessagePayload[]
  shiftPressed: Record<1 | 2, boolean>
  syncPressed: Record<1 | 2, boolean>
  jogTouched: Record<1 | 2, boolean>
  crossfaderPosition: number
  lastControl: MidiControlPayload | null
}

export const useMidiDeviceStore = defineStore('midiDevice', {
  state: (): MidiDeviceState => ({
    inputs: [],
    enabledByIdentifier: {},
    deckSelectionByIdentifier: {},
    devicePreferencesByIdentifier: {},
    hydrated: false,
    deckSelectionSyncPending: false,
    rescanning: false,
    monitorMessages: [],
    shiftPressed: { 1: false, 2: false },
    syncPressed: { 1: false, 2: false },
    jogTouched: { 1: false, 2: false },
    crossfaderPosition: 0.5,
    lastControl: null
  }),

  actions: {
    applyList(payload: MidiDevicesListPayload): void {
      const enabledIdentifiers = new Set(
        payload.inputs.filter((input) => input.enabled).map((input) => input.identifier)
      )
      for (const input of this.inputs) {
        if (input.enabled && !enabledIdentifiers.has(input.identifier)) {
          releaseMidiPlaybackHoldsForDevice(input.identifier)
        }
      }
      this.inputs = [...payload.inputs]
      this.hydrated = true
      this.finishRescan()
      if (!this.deckSelectionSyncPending) return

      this.deckSelectionSyncPending = false
      for (const input of payload.inputs) {
        if (!input.enabled) continue
        let selection = this.deckSelectionByIdentifier[input.identifier]
        if (!selection) {
          // No cue-set selection is persisted for this device: fall back to its
          // Default deck preference. This is applied to the live selection only
          // and never persisted, so the preference re-applies on every startup
          // until the cue button saves an explicit selection.
          const defaultDeck =
            this.devicePreferencesByIdentifier[input.identifier]?.defaultDeck ??
            DEFAULT_MIDI_DEVICE_PREFERENCES.defaultDeck
          if (defaultDeck === 'none') continue
          selection = deckSelectionForDefault(defaultDeck)
          this.deckSelectionByIdentifier = {
            ...this.deckSelectionByIdentifier,
            [input.identifier]: selection
          }
        }
        sendBridge('MIDI_DECK_SELECTION_SET', {
          deviceIdentifier: input.identifier,
          ...selection
        })
      }
    },

    recordMessage(payload: MidiMessagePayload): void {
      this.monitorMessages.unshift(payload)
      if (this.monitorMessages.length > MAX_MONITOR_MESSAGES) {
        this.monitorMessages.length = MAX_MONITOR_MESSAGES
      }
    },

    clearMonitorMessages(): void {
      this.monitorMessages = []
    },

    applyControl(payload: MidiControlPayload): void {
      this.lastControl = payload
      if (payload.kind === 'absolute' && payload.control === 'crossfader') {
        this.crossfaderPosition = payload.value
      } else if (payload.kind === 'button' && payload.control === 'shift') {
        this.shiftPressed[payload.deck] = payload.pressed
      } else if (payload.kind === 'button' && payload.control === 'syncModifier') {
        this.syncPressed[payload.deck] = payload.pressed
      } else if (payload.kind === 'button' && payload.control === 'jogTouch') {
        this.jogTouched[payload.deck] = payload.pressed
      }
    },

    applyDeckSelection(payload: MidiDeckSelectionPayload): void {
      const selection = {
        deck1Enabled: payload.deck1Enabled,
        deck2Enabled: payload.deck2Enabled
      }
      this.deckSelectionByIdentifier = {
        ...this.deckSelectionByIdentifier,
        [payload.deviceIdentifier]: selection
      }
      if (!payload.deck1Enabled) {
        releaseMidiPlaybackHoldsForDeck(payload.deviceIdentifier, 1)
        this.shiftPressed[1] = false
        this.syncPressed[1] = false
        this.jogTouched[1] = false
      }
      if (!payload.deck2Enabled) {
        releaseMidiPlaybackHoldsForDeck(payload.deviceIdentifier, 2)
        this.shiftPressed[2] = false
        this.syncPressed[2] = false
        this.jogTouched[2] = false
      }
      window.silverdaw.setMidiDeckSelection(payload.deviceIdentifier, selection)
    },

    isScrubAudioEnabled(identifier: string): boolean {
      return (
        this.devicePreferencesByIdentifier[identifier]?.scrubAudioEnabled ??
        DEFAULT_MIDI_DEVICE_PREFERENCES.scrubAudioEnabled
      )
    },

    applyDevicePreferences(preferences: Record<string, MidiDevicePreferences>): void {
      this.devicePreferencesByIdentifier = Object.fromEntries(
        Object.entries(preferences).map(([identifier, value]) => [
          identifier,
          {
            scrubAudioEnabled: value.scrubAudioEnabled,
            crossfaderDirection: value.crossfaderDirection,
            defaultDeck: value.defaultDeck
          }
        ])
      )
      this.pushScratchSettings()
    },

    /** Ask the backend to enumerate MIDI inputs; the reply lands in `applyList`. */
    requestList(): void {
      sendBridge('MIDI_DEVICES_REQUEST')
    },

    /** Reload persisted enabled inputs and re-apply them after a backend reconnect. */
    async applyEnabledInputsOnReady(): Promise<void> {
      try {
        this.enabledByIdentifier = await window.silverdaw.getEnabledMidiInputs()
      } catch (err) {
        log.warn('midi', `enabled input hydrate failed: ${String(err)}`)
        this.enabledByIdentifier = {}
      }
      try {
        this.deckSelectionByIdentifier = await window.silverdaw.getMidiDeckSelections()
      } catch (err) {
        log.warn('midi', `deck selection hydrate failed: ${String(err)}`)
        this.deckSelectionByIdentifier = {}
      }
      try {
        this.devicePreferencesByIdentifier =
          await window.silverdaw.getMidiDevicePreferences()
      } catch (err) {
        log.warn('midi', `device preference hydrate failed: ${String(err)}`)
        this.devicePreferencesByIdentifier = {}
      }
      this.pushEnabledInputs()
      this.pushScratchSettings()
      this.requestList()
    },

    /** Apply an enabled input change for this session without persisting it. */
    setInputEnabledForSession(identifier: string, enabled: boolean): void {
      const input = this.inputs.find((candidate) => candidate.identifier === identifier)
      if (enabled && input?.controllerProfile === null) {
        log.warn('midi', `cannot enable unsupported MIDI input: ${input.name}`)
        return
      }
      if (enabled) this.enabledByIdentifier[identifier] = true
      else delete this.enabledByIdentifier[identifier]
      this.pushEnabledInputs()
    },

    applyEnabledInputs(enabledByIdentifier: Record<string, boolean>): void {
      this.enabledByIdentifier = { ...enabledByIdentifier }
      this.pushEnabledInputs()
    },

    pushEnabledInputs(): void {
      const identifiers = Object.keys(this.enabledByIdentifier)
      this.deckSelectionSyncPending = sendBridge('MIDI_INPUTS_SET', {
        identifiers
      })
    },

    /** Send MIDI_SCRATCH_SETTINGS_SET for each device with crossfader direction
     *  preferences so the backend scratch router honours the configured direction. */
    pushScratchSettings(): void {
      for (const [identifier, prefs] of Object.entries(this.devicePreferencesByIdentifier)) {
        sendBridge('MIDI_SCRATCH_SETTINGS_SET', {
          deviceIdentifier: identifier,
          crossfaderDirection: prefs.crossfaderDirection
        })
      }
    },

    /** Show rescan progress until the refreshed device list arrives. */
    requestRescan(): void {
      if (this.rescanning) return
      this.rescanning = true
      if (rescanSafetyTimer) clearTimeout(rescanSafetyTimer)
      rescanSafetyTimer = setTimeout(() => {
        rescanSafetyTimer = null
        this.finishRescan()
      }, RESCAN_SAFETY_MS)
      if (!sendBridge('MIDI_DEVICES_REQUEST')) this.finishRescan()
    },

    /** Clear the rescan state, including its fallback timeout. */
    finishRescan(): void {
      if (rescanSafetyTimer) {
        clearTimeout(rescanSafetyTimer)
        rescanSafetyTimer = null
      }
      this.rescanning = false
    }
  }
})
