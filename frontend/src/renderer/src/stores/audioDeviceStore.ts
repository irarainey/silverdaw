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
  /** User override for the output keep-awake dither + first-play wake burst. */
  keepAwakeMode: KeepAwakeMode
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
    keepAwakeMode: 'auto'
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
    }
  },

  actions: {
    applyList(payload: AudioDevicesListPayload): void {
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

    /** Persist + apply a keep-awake override; pushes it to the backend live. */
    setKeepAwakeMode(mode: KeepAwakeMode): void {
      this.keepAwakeMode = mode
      window.silverdaw.setKeepAwakeMode(mode)
      sendBridge('AUDIO_KEEP_AWAKE_SET', { mode })
    },

    /**
     * On every bridge (re)connect the backend starts at its `auto` default, so re-send the user's
     * persisted keep-awake override once the engine is ready.
     */
    async applyKeepAwakeOnReady(): Promise<void> {
      try {
        this.keepAwakeMode = await window.silverdaw.getKeepAwakeMode()
      } catch (err) {
        log.warn('audio', `keep-awake hydrate failed, using auto: ${String(err)}`)
        this.keepAwakeMode = 'auto'
      }
      sendBridge('AUDIO_KEEP_AWAKE_SET', { mode: this.keepAwakeMode })
    }
  }
})
