// Per-project audio-output reconciliation for the app shell. Applies each
// saved project output once after both project and device state hydrate,
// switching the live device when available or warning when it is missing.
// Extracted from App.vue so the shell stays thin.

import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { log } from '@/lib/log'

export interface ProjectAudioOutputReconciliation {
  audioUnavailableOpen: Ref<boolean>
  audioUnavailableSavedTypeName: Ref<string | null>
  audioUnavailableSavedDeviceName: Ref<string | null>
}

// A saved output device can take a few seconds to enumerate after launch (a sleep-prone USB DAC
// only appears in a later scan). Actively probe for it a bounded number of times so startup
// recovers without the user opening the picker — then give up so we never poll indefinitely.
const MAX_RECONCILE_PROBES = 6
const RECONCILE_PROBE_INTERVAL_MS = 2000

export function useProjectAudioOutputReconciliation(): ProjectAudioOutputReconciliation {
  const project = useProjectStore()
  const audioDevices = useAudioDeviceStore()

  // Warn when a project's saved audio output is unavailable; live output stays unchanged.
  const audioUnavailableOpen = ref(false)
  const audioUnavailableSavedTypeName = ref<string | null>(null)
  const audioUnavailableSavedDeviceName = ref<string | null>(null)
  // Keys we have SUCCESSFULLY applied (switched to, or confirmed already active). An unavailable
  // device is NOT recorded here so it is retried when the device list next changes — a sleep-prone
  // USB DAC can take seconds to enumerate after launch, appearing only in a later scan / hotplug.
  const audioReconciledKeys = new Set<string>()
  // Keys we have already warned about, so the dialog is shown at most once per device.
  const audioWarnedKeys = new Set<string>()

  // Bounded background probe that hunts for a saved device that is slow to enumerate.
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  let probesRemaining = MAX_RECONCILE_PROBES

  function stopProbe(): void {
    if (probeTimer) {
      clearTimeout(probeTimer)
      probeTimer = null
    }
  }

  function scheduleProbe(): void {
    if (probeTimer || probesRemaining <= 0) return
    probeTimer = setTimeout(() => {
      probeTimer = null
      probesRemaining -= 1
      // The resulting device-list broadcast re-runs reconcile; if still unavailable and probes
      // remain, that pass schedules the next one.
      audioDevices.probeForDevices()
    }, RECONCILE_PROBE_INTERVAL_MS)
  }

  if (getCurrentScope()) onScopeDispose(stopProbe)

  function reconcileProjectAudioOutput(): void {
    if (!audioDevices.hydrated) return
    const projectId = project.projectId
    if (!projectId) return
    const savedType = project.audioOutputTypeName
    const savedDevice = project.audioOutputDeviceName
    if (!savedType || !savedDevice) return

    const key = `${projectId}::${savedType}::${savedDevice}`
    if (audioReconciledKeys.has(key)) return

    if (
      audioDevices.currentTypeName === savedType &&
      audioDevices.currentDeviceName === savedDevice
    ) {
      log.info('audio', `project audio output already active (${savedType} / ${savedDevice})`)
      audioReconciledKeys.add(key)
      audioUnavailableOpen.value = false
      stopProbe()
      return
    }

    // Do not override an in-flight user-initiated switch to the same device.
    const pending = audioDevices.pendingSelection
    if (pending && pending.typeName === savedType && pending.deviceName === savedDevice) {
      return
    }

    const available = audioDevices.flatDevices.some(
      (d) => d.typeName === savedType && d.deviceName === savedDevice
    )
    if (available) {
      log.info('audio', `switching to project audio output (${savedType} / ${savedDevice})`)
      audioReconciledKeys.add(key)
      // The device appeared (possibly after a slow enumeration); clear any stale warning.
      audioUnavailableOpen.value = false
      stopProbe()
      audioDevices.selectDevice(savedType, savedDevice, { persistUserPreference: false })
    } else {
      // Not available yet. Keep probing (bounded) so a slow USB DAC is picked up automatically,
      // and warn once. The key stays un-reconciled so the next device-list change retries.
      scheduleProbe()
      if (!audioWarnedKeys.has(key)) {
        audioWarnedKeys.add(key)
        log.warn(
          'audio',
          `project audio output unavailable (${savedType} / ${savedDevice}); leaving live device on default`
        )
        audioUnavailableSavedTypeName.value = savedType
        audioUnavailableSavedDeviceName.value = savedDevice
        audioUnavailableOpen.value = true
      }
    }
  }

  // Reconcile when project output, device hydration, OR the device list changes — the last is what
  // lets a slow-to-enumerate USB DAC be picked up and switched to once it finally appears.
  watch(
    () => [
      project.projectId,
      project.audioOutputTypeName,
      project.audioOutputDeviceName,
      audioDevices.hydrated,
      audioDevices.types
    ] as const,
    () => {
      reconcileProjectAudioOutput()
    },
    { immediate: true }
  )

  return { audioUnavailableOpen, audioUnavailableSavedTypeName, audioUnavailableSavedDeviceName }
}
