// Audio output device mirror.
//
// Tracks the backend's `juce::AudioDeviceManager` state so the
// Preferences > Audio tab and the TransportBar quick-switch can
// render the device list + current selection without each component
// re-requesting it. State is populated by two inbound envelopes:
//
//   - `AUDIO_DEVICES_LIST` — the full snapshot. Broadcast at boot,
//     after every successful switch, and whenever JUCE's
//     `audioDeviceListChanged` fires (USB plug / unplug, Windows
//     audio reconfig).
//
//   - `AUDIO_DEVICE_CHANGED` — ack for a `AUDIO_DEVICE_SELECT`. On
//     `ok: true` the persisted preference is written; on `ok: false`
//     the pending selection is dropped and the user-facing
//     `lastError` is set so the UI can surface a toast.
//
// Persistence is two-step on purpose: the renderer keeps a
// `pendingSelection` that's set the moment the user clicks (so the
// UI feels responsive) but only commits to disk via the main IPC
// `prefs:setAudioOutput` once the backend confirms the switch
// actually opened the device. A failed switch never persists a bad
// selection that would silently re-fail on every subsequent launch.

import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type {
  AudioDeviceChangedPayload,
  AudioDevicesListPayload,
  AudioDeviceTypeListing
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
  /** Effective output latency in ms (driver-reported + Bluetooth
   *  heuristic). Backend subtracts this from the broadcast playhead
   *  while playing so the visual cursor matches what the user hears.
   *  Surfaced read-only in the transport-bar audio chip when
   *  non-trivial. `null` until the first AUDIO_DEVICES_LIST. */
  outputLatencyMs: number | null
  /** True when the backend's name-based Bluetooth heuristic added a
   *  baseline latency on top of the driver report — i.e. the active
   *  device looks like a BT headset and we've adjusted for radio /
   *  headset-DSP pipeline that Windows doesn't measure. */
  isBluetoothHeuristic: boolean
  /** When non-null, the user has just clicked a device and we're
   *  waiting for the backend's `AUDIO_DEVICE_CHANGED` ack. The UI
   *  shows this entry as "switching…" until the ack lands. */
  pendingSelection: PendingSelection | null
  /** Set when the most recent `selectDevice` call was issued with
   *  `persistUserPreference: false` (project-load reconciliation or
   *  the Project Properties dialog Save). The
   *  `AUDIO_DEVICE_CHANGED` ack handler reads + clears this flag and
   *  skips the `setAudioOutput` IPC so the user-scope
   *  `preferences.json` isn't accidentally overwritten by a
   *  project-scoped switch. */
  pendingPersistUserPreference: boolean
  /** Most-recent switch error surfaced by the backend (or null on
   *  success). Used by the Preferences dialog + TransportBar to
   *  show a small warning chip. */
  lastError: string | null
  /** Set true by the initial AUDIO_DEVICES_LIST iff the backend's
   *  saved-device path failed at boot. The renderer pops a one-shot
   *  toast on the next state transition that explains the fallback. */
  startupFellBack: boolean
  /** True once at least one AUDIO_DEVICES_LIST has been received.
   *  The Preferences Audio tab gates its content on this so it
   *  doesn't briefly render an empty "no devices" list during the
   *  request round-trip. */
  hydrated: boolean
  /** True while the backend's deferred startup scan is still pending.
   *  The startup overlays surface a small "Scanning audio devices…"
   *  status hint until the post-scan snapshot arrives. */
  scanInProgress: boolean
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
    scanInProgress: false
  }),

  getters: {
    /** All devices flattened into a single list with their owning type
     *  attached. Used by the TransportBar quick-switch popover and
     *  any "is this entry valid?" lookup. */
    flatDevices(state): FlattenedDevice[] {
      const out: FlattenedDevice[] = []
      for (const t of state.types) {
        for (const d of t.devices) {
          out.push({ typeName: t.name, deviceName: d })
        }
      }
      return out
    },

    /** True when the active device is "system default" (no concrete
     *  type / name selected). */
    onSystemDefault(state): boolean {
      return !state.currentTypeName && !state.currentDeviceName
    }
  },

  actions: {
    /** Bridge dispatch: apply a fresh device snapshot. */
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
      // Clear any pending selection — the list reflects the actual
      // live device, so whatever the user clicked has either landed
      // (we don't care which) or been superseded.
      this.pendingSelection = null
      // The backend sends this flag once per startup fallback, but a few
      // AUDIO_DEVICES_LIST messages can still arrive close together (cached
      // snapshot then full scan). Surface the notice at most once, and as a
      // neutral info — the app has gracefully fallen back to the system
      // default, which isn't an error.
      if (payload.fellBackToDefault && !this.startupFellBack) {
        this.startupFellBack = true
        useNotificationsStore().pushInfo(
          'Saved audio output device was not available — using system default.'
        )
      }
    },

    /** Bridge dispatch: apply an AUDIO_DEVICE_CHANGED ack. */
    applyChanged(payload: AudioDeviceChangedPayload): void {
      if (payload.ok) {
        this.lastError = null
        // The backend will follow up with a refreshed
        // AUDIO_DEVICES_LIST that updates the current-selection
        // fields — main also persists the choice via `setAudioOutput`
        // below. Renderer-side we just clear the pending state.
        this.pendingSelection = null
        // Persist the now-confirmed selection to the user-scope
        // `preferences.json` UNLESS the originating `selectDevice`
        // call explicitly opted out (project-load reconcile and
        // Project Properties dialog Save both do — they want the
        // live device to switch without overwriting the user's
        // global fallback). Empty/null in the ack means "we switched
        // back to system default" — both fields are cleared in prefs
        // so the next launch boots on default too.
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

    /** User action: switch the active output device. `typeName` and
     *  `deviceName` both null = "revert to system default".
     *
     *  `opts.persistUserPreference` (default `true`) controls whether
     *  a successful switch also writes through to the user-scope
     *  `preferences.json` via the `setAudioOutput` IPC. Project-load
     *  reconciliation and the Project Properties dialog pass `false`
     *  so a per-project device choice doesn't silently overwrite the
     *  user's global default. */
    selectDevice(
      typeName: string | null,
      deviceName: string | null,
      opts?: { persistUserPreference?: boolean }
    ): void {
      // Optimistic UI: stash the pending selection so dropdowns and
      // the transport-bar label can show "switching to X…" while the
      // bridge round-trips.
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

    /** User action: ask the backend to rescan for new devices (USB
     *  plug, etc.). Cheap on most backends; ASIO may take ~10 ms. */
    requestRescan(): void {
      sendBridge('AUDIO_DEVICES_REQUEST', { refresh: true })
    },

    /** Called on bridge-ready to seed the store. The backend
     *  broadcasts AUDIO_DEVICES_LIST proactively after AUTH, but
     *  asking on connect makes the flow robust to a missed
     *  initial broadcast on reconnect. */
    requestInitialList(): void {
      sendBridge('AUDIO_DEVICES_REQUEST', { refresh: false })
    }
  }
})
