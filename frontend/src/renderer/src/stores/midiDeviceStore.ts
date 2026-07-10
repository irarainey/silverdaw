// MIDI input device mirror. The backend owns enumeration, opening inputs, and activity.

import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type {
  MidiControlPayload,
  MidiDevicesListPayload,
  MidiInputDevice,
  MidiMessagePayload
} from '@shared/bridge-protocol'

const RESCAN_SAFETY_MS = 6000
const MAX_MONITOR_MESSAGES = 200
let rescanSafetyTimer: ReturnType<typeof setTimeout> | null = null

interface MidiDeviceState {
  /** Connected MIDI input devices and their live backend state. */
  inputs: MidiInputDevice[]
  /** Persisted enabled inputs, keyed by JUCE device identifier. */
  enabledByIdentifier: Record<string, boolean>
  /** True after the first MIDI_DEVICES_LIST arrives. */
  hydrated: boolean
  /** True from a user-initiated rescan until the backend replies. */
  rescanning: boolean
  monitorMessages: MidiMessagePayload[]
  shiftPressed: Record<1 | 2, boolean>
  jogTouched: Record<1 | 2, boolean>
  crossfaderPosition: number
  lastControl: MidiControlPayload | null
}

export const useMidiDeviceStore = defineStore('midiDevice', {
  state: (): MidiDeviceState => ({
    inputs: [],
    enabledByIdentifier: {},
    hydrated: false,
    rescanning: false,
    monitorMessages: [],
    shiftPressed: { 1: false, 2: false },
    jogTouched: { 1: false, 2: false },
    crossfaderPosition: 0.5,
    lastControl: null
  }),

  actions: {
    applyList(payload: MidiDevicesListPayload): void {
      this.inputs = [...payload.inputs]
      this.hydrated = true
      this.finishRescan()
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
      if (payload.kind === 'absolute') {
        this.crossfaderPosition = payload.value
      } else if (payload.kind === 'button' && payload.control === 'shift') {
        this.shiftPressed[payload.deck] = payload.pressed
      } else if (payload.kind === 'button' && payload.control === 'jogTouch') {
        this.jogTouched[payload.deck] = payload.pressed
      }
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
      this.pushEnabledInputs()
      this.requestList()
    },

    /** Apply an enabled input change for this session without persisting it. */
    setInputEnabledForSession(identifier: string, enabled: boolean): void {
      if (enabled) this.enabledByIdentifier[identifier] = true
      else delete this.enabledByIdentifier[identifier]
      this.pushEnabledInputs()
    },

    applyEnabledInputs(enabledByIdentifier: Record<string, boolean>): void {
      this.enabledByIdentifier = { ...enabledByIdentifier }
      this.pushEnabledInputs()
    },

    pushEnabledInputs(): void {
      sendBridge('MIDI_INPUTS_SET', {
        identifiers: Object.keys(this.enabledByIdentifier)
      })
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
