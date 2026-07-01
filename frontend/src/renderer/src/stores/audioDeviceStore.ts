// Audio output device mirror; persistence waits for backend confirmation.

import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type {
  AudioDeviceChangedPayload,
  AudioDevicesListPayload,
  AudioDeviceTypeListing
} from '@shared/bridge-protocol'

// Keep the Rescan spinner visible at least this long so a fast rescan still reads as
// "working", and give up after the safety window if the backend never replies.
const RESCAN_MIN_SPINNER_MS = 500
const RESCAN_SAFETY_MS = 6000
let rescanClearTimer: ReturnType<typeof setTimeout> | null = null
let rescanSafetyTimer: ReturnType<typeof setTimeout> | null = null

interface PendingSelection {
  typeName: string | null
  deviceName: string | null
}

export interface FlattenedDevice {
  typeName: string
  deviceName: string
}

interface AudioDeviceState {
  types: AudioDeviceTypeListing[]
  currentTypeName: string | null
  currentDeviceName: string | null
  currentSampleRate: number | null
  currentBufferSize: number | null
  /** Effective output latency in ms, including backend Bluetooth heuristic. */
  outputLatencyMs: number | null
  /** Backend applied the Bluetooth latency heuristic. */
  isBluetoothHeuristic: boolean
  /** Pending optimistic selection until `AUDIO_DEVICE_CHANGED` arrives. */
  pendingSelection: PendingSelection | null
  /** False skips user-scope preference persistence for project-scoped switches. */
  pendingPersistUserPreference: boolean
  lastError: string | null
  /** True after the first `AUDIO_DEVICES_LIST`. */
  hydrated: boolean
  /** True while the backend's deferred startup scan is pending. */
  scanInProgress: boolean
  /** True from a user-initiated Rescan until the refreshed device list arrives. */
  rescanning: boolean
  /** Per-device keep-awake toggles (device name → true); absent / false = off. */
  keepAwakeByDevice: Record<string, boolean>
}

export const useAudioDeviceStore = defineStore('audioDevice', {
  state: (): AudioDeviceState => ({
    types: [],
    currentTypeName: null,
    currentDeviceName: null,
    currentSampleRate: null,
    currentBufferSize: null,
    outputLatencyMs: null,
    isBluetoothHeuristic: false,
    pendingSelection: null,
    pendingPersistUserPreference: true,
    lastError: null,
    hydrated: false,
    scanInProgress: false,
    rescanning: false,
    keepAwakeByDevice: {}
  }),

  getters: {
    flatDevices(state): FlattenedDevice[] {
      const out: FlattenedDevice[] = []
      for (const t of state.types) {
        for (const d of t.devices) {
          out.push({ typeName: t.name, deviceName: d })
        }
      }
      return out
    },

    /** Whether the physically-open output device is kept awake (absent = off). */
    currentDeviceKeepAwakeEnabled(state): boolean {
      const name = state.currentDeviceName
      return !!(name && state.keepAwakeByDevice[name])
    }
  },

  actions: {
    applyList(payload: AudioDevicesListPayload): void {
      const previousDeviceName = this.currentDeviceName
      this.types = payload.types
      this.currentTypeName = payload.currentTypeName
      this.currentDeviceName =
        payload.currentDeviceName && payload.currentDeviceName.length > 0
          ? payload.currentDeviceName
          : null
      this.currentSampleRate = payload.currentSampleRate ?? null
      this.currentBufferSize = payload.currentBufferSize ?? null
      this.outputLatencyMs = payload.outputLatencyMs ?? null
      this.isBluetoothHeuristic = (payload.heuristicExtraLatencyMs ?? 0) > 0
      this.hydrated = true
      this.scanInProgress = payload.scanInProgress === true
      this.pendingSelection = null
      // The saved device being unavailable at startup is handled silently: the backend
      // has already opened a working fallback, and there is nothing the user can do (nor
      // any way to dismiss a recurring notice), so no toast is shown.
      // Keep-awake is per physical device, so re-push the effective state whenever the
      // open device changes (e.g. a USB DAC is unplugged and playback falls back to the
      // onboard card — its own toggle, off by default, applies).
      if (this.currentDeviceName !== previousDeviceName) {
        this.pushEffectiveKeepAwake()
      }
      // A user rescan resolves when this refreshed list lands; hold the spinner a beat
      // longer so an instant rescan still reads as "working".
      if (this.rescanning) {
        if (rescanClearTimer) clearTimeout(rescanClearTimer)
        rescanClearTimer = setTimeout(() => {
          rescanClearTimer = null
          this.finishRescan()
        }, RESCAN_MIN_SPINNER_MS)
      }
    },

    applyChanged(payload: AudioDeviceChangedPayload): void {
      if (payload.ok) {
        this.lastError = null
        this.pendingSelection = null
        // Persist only user-scope switches; project-scoped switches opt out.
        if (this.pendingPersistUserPreference) {
          window.silverdaw.setAudioOutput({
            typeName: payload.typeName,
            deviceName: payload.deviceName
          })
        }
        this.pendingPersistUserPreference = true
        log.info(
          'audio',
          `device switched typeName=${payload.typeName ?? 'default'} deviceName=${payload.deviceName ?? 'default'}`
        )
      } else {
        const message = payload.error || 'Audio device switch failed'
        this.lastError = message
        this.pendingSelection = null
        this.pendingPersistUserPreference = true
        useNotificationsStore().pushError(message)
        log.warn('audio', `device switch failed: ${message}`)
      }
    },

    /** `persistUserPreference: false` switches live output without changing user defaults. */
    selectDevice(
      typeName: string | null,
      deviceName: string | null,
      opts?: { persistUserPreference?: boolean }
    ): void {
      this.pendingSelection = { typeName, deviceName }
      this.pendingPersistUserPreference = opts?.persistUserPreference ?? true
      this.lastError = null
      const sent = sendBridge('AUDIO_DEVICE_SELECT', { typeName, deviceName })
      if (!sent) {
        this.pendingSelection = null
        this.pendingPersistUserPreference = true
        this.lastError = 'The audio engine isn\'t connected'
        useNotificationsStore().pushError('Could not switch audio device: the audio engine isn\'t connected.')
      }
    },

    /** User-initiated device rescan. Shows a spinner until the refreshed list arrives
     *  (the backend rebuilds + broadcasts synchronously; even if the device set is
     *  unchanged the spinner confirms it did something). */
    requestRescan(): void {
      if (this.rescanning) return
      this.rescanning = true
      if (rescanSafetyTimer) clearTimeout(rescanSafetyTimer)
      rescanSafetyTimer = setTimeout(() => {
        rescanSafetyTimer = null
        this.finishRescan()
      }, RESCAN_SAFETY_MS)
      const sent = sendBridge('AUDIO_DEVICES_REQUEST', { refresh: true })
      if (!sent) this.finishRescan()
    },

    /** Clear the rescan spinner + timers. */
    finishRescan(): void {
      if (rescanClearTimer) {
        clearTimeout(rescanClearTimer)
        rescanClearTimer = null
      }
      if (rescanSafetyTimer) {
        clearTimeout(rescanSafetyTimer)
        rescanSafetyTimer = null
      }
      this.rescanning = false
    },

    /** Bridge-ready fallback in case the proactive snapshot was missed. */
    requestInitialList(): void {
      sendBridge('AUDIO_DEVICES_REQUEST', { refresh: false })
    },

    /** Send the current physical device's effective keep-awake state to the backend. */
    pushEffectiveKeepAwake(): void {
      sendBridge('AUDIO_KEEP_AWAKE_SET', { enabled: this.currentDeviceKeepAwakeEnabled })
    },

    /** Enable / disable keep-awake for a named output device, persist it per-device,
     *  and re-push the open device's effective state. */
    setKeepAwakeForDevice(deviceName: string, enabled: boolean): void {
      const name = deviceName.trim()
      if (name.length === 0) return
      if (enabled) {
        this.keepAwakeByDevice[name] = true
      } else {
        delete this.keepAwakeByDevice[name]
      }
      window.silverdaw.setKeepAwakeForDevice(name, enabled)
      this.pushEffectiveKeepAwake()
    },

    /**
     * On every bridge (re)connect the backend starts at its `auto` default, so reload the
     * persisted per-device overrides and re-send the open device's effective mode once ready.
     */
    async applyKeepAwakeOnReady(): Promise<void> {
      try {
        this.keepAwakeByDevice = await window.silverdaw.getKeepAwakeByDevice()
      } catch (err) {
        log.warn('audio', `keep-awake hydrate failed, using auto: ${String(err)}`)
        this.keepAwakeByDevice = {}
      }
      this.pushEffectiveKeepAwake()
    }
  }
})
