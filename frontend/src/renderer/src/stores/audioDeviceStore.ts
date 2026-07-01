// Audio output device mirror; persistence waits for backend confirmation.

import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type {
  AudioDeviceChangedPayload,
  AudioDevicesListPayload,
  AudioDeviceTypeListing,
  KeepAwakeMode
} from '@shared/bridge-protocol'

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
  /** One-shot startup fallback notice guard. */
  startupFellBack: boolean
  /** True after the first `AUDIO_DEVICES_LIST`. */
  hydrated: boolean
  /** True while the backend's deferred startup scan is pending. */
  scanInProgress: boolean
  /** Per-device keep-awake overrides (device name → mode); absent = `auto`. */
  keepAwakeByDevice: Record<string, KeepAwakeMode>
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
    startupFellBack: false,
    hydrated: false,
    scanInProgress: false,
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

    onSystemDefault(state): boolean {
      return !state.currentTypeName && !state.currentDeviceName
    },

    /** The keep-awake mode for the physically-open output device (absent = `auto`). */
    currentDeviceKeepAwakeMode(state): KeepAwakeMode {
      const name = state.currentDeviceName
      return (name && state.keepAwakeByDevice[name]) || 'auto'
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
      // A startup fallback may arrive in multiple close snapshots; notify once.
      if (payload.fellBackToDefault && !this.startupFellBack) {
        this.startupFellBack = true
        useNotificationsStore().pushInfo(
          'Saved audio output device was not available — using system default.'
        )
      }
      // The keep-awake policy is per physical device, so re-push the effective mode
      // whenever the open device changes (e.g. a USB DAC is unplugged and playback
      // falls back to the onboard card — its own override, default `auto`, applies).
      if (this.currentDeviceName !== previousDeviceName) {
        this.pushEffectiveKeepAwake()
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

    requestRescan(): void {
      sendBridge('AUDIO_DEVICES_REQUEST', { refresh: true })
    },

    /** Bridge-ready fallback in case the proactive snapshot was missed. */
    requestInitialList(): void {
      sendBridge('AUDIO_DEVICES_REQUEST', { refresh: false })
    },

    /** Send the current physical device's effective keep-awake mode to the backend. */
    pushEffectiveKeepAwake(): void {
      sendBridge('AUDIO_KEEP_AWAKE_SET', { mode: this.currentDeviceKeepAwakeMode })
    },

    /** Pin (or clear, with `auto`) the keep-awake override for a named output device,
     *  persist it per-device, and re-push the open device's effective mode. */
    setKeepAwakeForDevice(deviceName: string, mode: KeepAwakeMode): void {
      const name = deviceName.trim()
      if (name.length === 0) return
      if (mode === 'auto') {
        delete this.keepAwakeByDevice[name]
      } else {
        this.keepAwakeByDevice[name] = mode
      }
      window.silverdaw.setKeepAwakeForDevice(name, mode)
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
