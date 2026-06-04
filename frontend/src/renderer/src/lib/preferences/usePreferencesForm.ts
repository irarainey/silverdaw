// Transactional form model for PreferencesDialog, extracted from the SFC.
// Owns the working copies of every preference (edited freely by the dialog
// controls), the snapshot of their values when the dialog opened, the
// change-detection computed, and the load / persist logic. The dialog stays
// purely presentational: it binds to these refs and calls `save()` on Save.
//
// Nothing here is persisted until `save()` runs; until then edits live only in
// the working refs, so Cancel / Esc simply discards by re-loading next open.
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useAppStore } from '@/stores/appStore'
import { useUiStore, type SkipButtonTarget, type WaveformDisplayMode } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import {
  BACKEND_PREFERENCE,
  preferredBackendFor,
  useUniqueAudioDevices,
  type UniqueDevice
} from '@/lib/audio/audioOutputPicker'

export interface PreferencesForm {
  uniqueDevices: Ref<readonly UniqueDevice[]>
  audioOutputTypeName: Ref<string | null>
  audioOutputDeviceName: Ref<string | null>
  audioHasSelection: ComputedRef<boolean>
  isAudioOutputSelectedDevice: (deviceName: string) => boolean
  pickDevice: (device: UniqueDevice) => void
  pickSystemDefault: () => void
  backendsForSelectedDevice: ComputedRef<string[]>
  showAdvancedBackend: Ref<boolean>
  pickBackend: (typeName: string) => void
  loggingEnabled: Ref<boolean>
  devToolsEnabled: Ref<boolean>
  logDirectory: Ref<string>
  toastsEnabled: Ref<boolean>
  followPlayback: Ref<boolean>
  showLibraryTileImages: Ref<boolean>
  matchProjectTempoOnDrop: Ref<boolean>
  skipButtonTarget: Ref<SkipButtonTarget>
  waveformDisplayMode: Ref<WaveformDisplayMode>
  defaultProjectSampleRate: Ref<number>
  defaultProjectDir: Ref<string>
  defaultClipDir: Ref<string>
  autosaveEnabled: Ref<boolean>
  autosaveIntervalSeconds: Ref<number>
  initialLoggingEnabled: Ref<boolean>
  initialDevToolsEnabled: Ref<boolean>
  initialLogDirectory: Ref<string>
  hasChanges: ComputedRef<boolean>
  loadCurrent: () => Promise<void>
  chooseProjectDir: () => Promise<void>
  chooseClipDir: () => Promise<void>
  chooseLogDir: () => Promise<void>
  save: () => void
}

export function usePreferencesForm(): PreferencesForm {
  const appStore = useAppStore()
  const ui = useUiStore()
  const audioDevices = useAudioDeviceStore()
  const uniqueDevices = useUniqueAudioDevices()

  // Pending audio-output selection — edited freely by the radio buttons;
  // persisted (and applied to the engine) only when the user clicks Save.
  // `null/null` means "use system default".
  const audioOutputTypeName = ref<string | null>(null)
  const audioOutputDeviceName = ref<string | null>(null)
  const initialAudioOutputTypeName = ref<string | null>(null)
  const initialAudioOutputDeviceName = ref<string | null>(null)

  const audioHasSelection = computed(
    () => !!audioOutputTypeName.value && !!audioOutputDeviceName.value
  )

  function isAudioOutputSelectedDevice(deviceName: string): boolean {
    return audioOutputDeviceName.value?.toLowerCase() === deviceName.toLowerCase()
  }

  // Selecting a device row picks its preferred backend automatically. If the
  // user already picked this device but with a different backend (via the
  // advanced disclosure), keep their backend choice — we only auto-pick when
  // switching to a different device.
  function pickDevice(device: UniqueDevice): void {
    if (audioOutputDeviceName.value?.toLowerCase() === device.name.toLowerCase()) return
    audioOutputDeviceName.value = device.name
    audioOutputTypeName.value = preferredBackendFor(device)
  }

  function pickSystemDefault(): void {
    audioOutputDeviceName.value = null
    audioOutputTypeName.value = null
  }

  // Backends available for the currently-selected device — drives the advanced
  // disclosure. Empty when the user is on System default.
  const backendsForSelectedDevice = computed<string[]>(() => {
    const name = audioOutputDeviceName.value
    if (!name) return []
    const dev = uniqueDevices.value.find((d) => d.name.toLowerCase() === name.toLowerCase())
    return dev
      ? dev.backends.slice().sort((a, b) => {
          const ai = BACKEND_PREFERENCE.indexOf(a)
          const bi = BACKEND_PREFERENCE.indexOf(b)
          return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
        })
      : []
  })

  // Toggle controlling visibility of the audio-driver picker. Hidden by default
  // so the typical user sees a simple list of devices and isn't bothered by
  // Windows Audio / DirectSound / ASIO duplicates.
  const showAdvancedBackend = ref(false)

  function pickBackend(typeName: string): void {
    audioOutputTypeName.value = typeName
  }

  // Working copies — edited freely; not persisted until Save.
  const loggingEnabled = ref(false)
  const devToolsEnabled = ref(false)
  const logDirectory = ref('')
  const toastsEnabled = ref(true)
  const followPlayback = ref(true)
  const showLibraryTileImages = ref(true)
  const matchProjectTempoOnDrop = ref(true)
  const skipButtonTarget = ref<SkipButtonTarget>('timelineEnds')
  const waveformDisplayMode = ref<WaveformDisplayMode>('summary')
  const defaultProjectSampleRate = ref<number>(44100)
  const defaultProjectDir = ref('')
  const defaultClipDir = ref('')
  const autosaveEnabled = ref(true)
  const autosaveIntervalSeconds = ref(30)

  // Snapshot of the values when the dialog opened, used to:
  //   1. Detect whether anything actually changed (Save no-ops if not).
  //   2. Show the "Restart required" notice when debug differs.
  const initialLoggingEnabled = ref(false)
  const initialDevToolsEnabled = ref(false)
  const initialLogDirectory = ref('')
  const initialToasts = ref(true)
  const initialFollow = ref(true)
  const initialShowLibraryTileImages = ref(true)
  const initialMatchProjectTempoOnDrop = ref(true)
  const initialSkipButtonTarget = ref<SkipButtonTarget>('timelineEnds')
  const initialWaveformDisplayMode = ref<WaveformDisplayMode>('summary')
  const initialDefaultProjectSampleRate = ref<number>(44100)
  const initialProjectDir = ref('')
  const initialClipDir = ref('')
  const initialAutosaveEnabled = ref(true)
  const initialAutosaveSeconds = ref(30)

  const hasChanges = computed(
    () =>
      loggingEnabled.value !== initialLoggingEnabled.value ||
      devToolsEnabled.value !== initialDevToolsEnabled.value ||
      logDirectory.value !== initialLogDirectory.value ||
      toastsEnabled.value !== initialToasts.value ||
      followPlayback.value !== initialFollow.value ||
      showLibraryTileImages.value !== initialShowLibraryTileImages.value ||
      matchProjectTempoOnDrop.value !== initialMatchProjectTempoOnDrop.value ||
      skipButtonTarget.value !== initialSkipButtonTarget.value ||
      waveformDisplayMode.value !== initialWaveformDisplayMode.value ||
      defaultProjectSampleRate.value !== initialDefaultProjectSampleRate.value ||
      defaultProjectDir.value !== initialProjectDir.value ||
      defaultClipDir.value !== initialClipDir.value ||
      autosaveEnabled.value !== initialAutosaveEnabled.value ||
      autosaveIntervalSeconds.value !== initialAutosaveSeconds.value ||
      audioOutputTypeName.value !== initialAudioOutputTypeName.value ||
      audioOutputDeviceName.value !== initialAudioOutputDeviceName.value
  )

  async function loadCurrent(): Promise<void> {
    try {
      const [debugVal, qol, autosave, audioPref] = await Promise.all([
        window.silverdaw.getDebugPreferences(),
        window.silverdaw.getQolPrefs(),
        window.silverdaw.getAutosaveConfig(),
        window.silverdaw.getAudioOutput()
      ])
      loggingEnabled.value = debugVal.loggingEnabled
      devToolsEnabled.value = debugVal.devToolsEnabled
      logDirectory.value = debugVal.logDirectory
      toastsEnabled.value = qol.toasts.enabled
      defaultProjectDir.value = qol.paths.defaultProjectDir
      defaultClipDir.value = qol.paths.defaultClipDir
      autosaveEnabled.value = autosave.enabled
      autosaveIntervalSeconds.value = autosave.intervalSeconds
      // Audio: seed from the *saved preference*, not the live device.
      // A fresh install with no explicit pick has both fields null,
      // which the radio group renders as "System default" — even
      // though the engine is technically driving a concrete device
      // it chose itself. The user's actual choice is what's persisted,
      // not what JUCE happened to open.
      audioOutputTypeName.value = audioPref.typeName
      audioOutputDeviceName.value = audioPref.deviceName
    } catch {
      loggingEnabled.value = false
      devToolsEnabled.value = false
      logDirectory.value = ''
      toastsEnabled.value = true
      defaultProjectDir.value = ''
      defaultClipDir.value = ''
      autosaveEnabled.value = true
      autosaveIntervalSeconds.value = 30
      audioOutputTypeName.value = null
      audioOutputDeviceName.value = null
    }
    // `followPlayback` lives in the UI prefs sub-tree (alongside panel
    // sizes) and is mirrored into the uiStore on startup — read it from
    // there directly so we don't need a second IPC round-trip.
    followPlayback.value = ui.followPlayback
    showLibraryTileImages.value = ui.showLibraryTileImages
    matchProjectTempoOnDrop.value = ui.matchProjectTempoOnDrop
    skipButtonTarget.value = ui.skipButtonTarget
    waveformDisplayMode.value = ui.waveformDisplayMode
    defaultProjectSampleRate.value = ui.defaultProjectSampleRate
    initialLoggingEnabled.value = loggingEnabled.value
    initialDevToolsEnabled.value = devToolsEnabled.value
    initialLogDirectory.value = logDirectory.value
    initialToasts.value = toastsEnabled.value
    initialFollow.value = followPlayback.value
    initialShowLibraryTileImages.value = showLibraryTileImages.value
    initialMatchProjectTempoOnDrop.value = matchProjectTempoOnDrop.value
    initialSkipButtonTarget.value = skipButtonTarget.value
    initialWaveformDisplayMode.value = waveformDisplayMode.value
    initialDefaultProjectSampleRate.value = defaultProjectSampleRate.value
    initialProjectDir.value = defaultProjectDir.value
    initialClipDir.value = defaultClipDir.value
    initialAutosaveEnabled.value = autosaveEnabled.value
    initialAutosaveSeconds.value = autosaveIntervalSeconds.value
    initialAudioOutputTypeName.value = audioOutputTypeName.value
    initialAudioOutputDeviceName.value = audioOutputDeviceName.value
  }

  async function chooseProjectDir(): Promise<void> {
    const picked = await window.silverdaw.chooseDirectory({
      title: 'Default project folder',
      defaultPath: defaultProjectDir.value || undefined
    })
    if (picked) defaultProjectDir.value = picked
  }

  async function chooseClipDir(): Promise<void> {
    const picked = await window.silverdaw.chooseDirectory({
      title: 'Default clip folder',
      defaultPath: defaultClipDir.value || undefined
    })
    if (picked) defaultClipDir.value = picked
  }

  async function chooseLogDir(): Promise<void> {
    const picked = await window.silverdaw.chooseDirectory({
      title: 'Diagnostic log folder',
      defaultPath: logDirectory.value || defaultProjectDir.value || undefined
    })
    if (picked) logDirectory.value = picked
  }

  function save(): void {
    // Only push the deltas main needs to know about. The toast toggle is
    // also mirrored into the appStore so the change is visible to
    // `notificationsStore.push` without a re-hydrate.
    const qolPatch: {
      toasts?: { enabled: boolean }
      paths?: { defaultProjectDir?: string; defaultClipDir?: string }
    } = {}
    if (toastsEnabled.value !== initialToasts.value) {
      qolPatch.toasts = { enabled: toastsEnabled.value }
      appStore.setToastsEnabled(toastsEnabled.value)
    }
    const pathsPatch: { defaultProjectDir?: string; defaultClipDir?: string } = {}
    if (defaultProjectDir.value !== initialProjectDir.value && defaultProjectDir.value.length > 0) {
      pathsPatch.defaultProjectDir = defaultProjectDir.value
    }
    if (defaultClipDir.value !== initialClipDir.value && defaultClipDir.value.length > 0) {
      pathsPatch.defaultClipDir = defaultClipDir.value
    }
    if (Object.keys(pathsPatch).length > 0) {
      qolPatch.paths = pathsPatch
    }
    if (Object.keys(qolPatch).length > 0) {
      window.silverdaw.setQolPrefs(qolPatch)
    }
    if (
      loggingEnabled.value !== initialLoggingEnabled.value ||
      devToolsEnabled.value !== initialDevToolsEnabled.value ||
      logDirectory.value !== initialLogDirectory.value
    ) {
      window.silverdaw.setDebugPreferences({
        loggingEnabled: loggingEnabled.value,
        devToolsEnabled: devToolsEnabled.value,
        logDirectory: logDirectory.value.trim()
      })
    }
    if (followPlayback.value !== initialFollow.value) {
      // Goes through the uiStore so the transport-bar toggle stays in
      // sync and the new value is persisted via the usual UI prefs path.
      ui.setFollowPlayback(followPlayback.value)
    }
    if (showLibraryTileImages.value !== initialShowLibraryTileImages.value) {
      ui.setShowLibraryTileImages(showLibraryTileImages.value)
    }
    if (matchProjectTempoOnDrop.value !== initialMatchProjectTempoOnDrop.value) {
      ui.setMatchProjectTempoOnDrop(matchProjectTempoOnDrop.value)
    }
    if (skipButtonTarget.value !== initialSkipButtonTarget.value) {
      ui.setSkipButtonTarget(skipButtonTarget.value)
    }
    if (waveformDisplayMode.value !== initialWaveformDisplayMode.value) {
      ui.setWaveformDisplayMode(waveformDisplayMode.value)
    }
    if (defaultProjectSampleRate.value !== initialDefaultProjectSampleRate.value) {
      ui.setDefaultProjectSampleRate(defaultProjectSampleRate.value)
    }
    // Autosave config is also mirrored in appStore so the autosave
    // manager's reactive watcher picks up the change without waiting
    // for a re-hydrate.
    if (
      autosaveEnabled.value !== initialAutosaveEnabled.value ||
      autosaveIntervalSeconds.value !== initialAutosaveSeconds.value
    ) {
      const next = {
        enabled: autosaveEnabled.value,
        intervalSeconds: Math.max(5, Math.min(600, Math.round(autosaveIntervalSeconds.value)))
      }
      window.silverdaw.setAutosaveConfig(next)
      appStore.setAutosaveConfig(next)
    }
    // Audio output device: routes through the same
    // `audioDeviceStore.selectDevice` path the transport-bar
    // quick-switch uses. The store optimistic-updates locally, sends
    // `AUDIO_DEVICE_SELECT` over the bridge, and persists via main IPC
    // only after the backend acks `ok: true` — so an unreachable
    // device picked here is never written to disk.
    if (
      audioOutputTypeName.value !== initialAudioOutputTypeName.value ||
      audioOutputDeviceName.value !== initialAudioOutputDeviceName.value
    ) {
      audioDevices.selectDevice(audioOutputTypeName.value, audioOutputDeviceName.value)
    }
  }

  return {
    uniqueDevices,
    audioOutputTypeName,
    audioOutputDeviceName,
    audioHasSelection,
    isAudioOutputSelectedDevice,
    pickDevice,
    pickSystemDefault,
    backendsForSelectedDevice,
    showAdvancedBackend,
    pickBackend,
    loggingEnabled,
    devToolsEnabled,
    logDirectory,
    toastsEnabled,
    followPlayback,
    showLibraryTileImages,
    matchProjectTempoOnDrop,
    skipButtonTarget,
    waveformDisplayMode,
    defaultProjectSampleRate,
    defaultProjectDir,
    defaultClipDir,
    autosaveEnabled,
    autosaveIntervalSeconds,
    initialLoggingEnabled,
    initialDevToolsEnabled,
    initialLogDirectory,
    hasChanges,
    loadCurrent,
    chooseProjectDir,
    chooseClipDir,
    chooseLogDir,
    save
  }
}
