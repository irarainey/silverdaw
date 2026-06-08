// Per-project audio-output reconciliation for the app shell. Applies each
// saved project output once after both project and device state hydrate,
// switching the live device when available or warning when it is missing.
// Extracted from App.vue so the shell stays thin.

import { ref, watch, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { log } from '@/lib/log'

export interface ProjectAudioOutputReconciliation {
  audioUnavailableOpen: Ref<boolean>
  audioUnavailableSavedTypeName: Ref<string | null>
  audioUnavailableSavedDeviceName: Ref<string | null>
}

export function useProjectAudioOutputReconciliation(): ProjectAudioOutputReconciliation {
  const project = useProjectStore()
  const audioDevices = useAudioDeviceStore()

  // Warn when a project's saved audio output is unavailable; live output stays unchanged.
  const audioUnavailableOpen = ref(false)
  const audioUnavailableSavedTypeName = ref<string | null>(null)
  const audioUnavailableSavedDeviceName = ref<string | null>(null)
  // Dedupe unavailable-output warnings per renderer session.
  const audioReconciledKeys = new Set<string>()

  function reconcileProjectAudioOutput(): void {
    if (!audioDevices.hydrated) return
    const projectId = project.projectId
    if (!projectId) return
    const savedType = project.audioOutputTypeName
    const savedDevice = project.audioOutputDeviceName
    if (!savedType || !savedDevice) return

    const key = `${projectId}::${savedType}::${savedDevice}`
    if (audioReconciledKeys.has(key)) return
    audioReconciledKeys.add(key)

    if (
      audioDevices.currentTypeName === savedType &&
      audioDevices.currentDeviceName === savedDevice
    ) {
      log.info('audio', `project audio output already active (${savedType} / ${savedDevice})`)
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
      audioDevices.selectDevice(savedType, savedDevice, { persistUserPreference: false })
    } else {
      log.warn(
        'audio',
        `project audio output unavailable (${savedType} / ${savedDevice}); leaving live device on default`
      )
      audioUnavailableSavedTypeName.value = savedType
      audioUnavailableSavedDeviceName.value = savedDevice
      audioUnavailableOpen.value = true
    }
  }

  // Reconcile when project output or device hydration changes.
  watch(
    () => [
      project.projectId,
      project.audioOutputTypeName,
      project.audioOutputDeviceName,
      audioDevices.hydrated
    ] as const,
    () => {
      reconcileProjectAudioOutput()
    },
    { immediate: true }
  )

  return { audioUnavailableOpen, audioUnavailableSavedTypeName, audioUnavailableSavedDeviceName }
}
