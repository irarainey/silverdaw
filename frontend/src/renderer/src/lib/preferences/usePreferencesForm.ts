// Transactional form model for PreferencesDialog; nothing persists until `save()`.
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { VocalEnhanceStrength, DrumEnhanceStrength, BassEnhanceStrength, OtherEnhanceStrength, KeepAwakeMode } from '@shared/bridge-protocol'
import { useAppStore } from '@/stores/appStore'
import { useUiStore, type SkipButtonTarget, type WaveformDisplayMode } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useBrakeSettingsStore } from '@/stores/brakeSettingsStore'
import { useBackspinSettingsStore } from '@/stores/backspinSettingsStore'
import type { BrakeDurationDto, BrakeCurveDto, BackspinDurationDto, BackspinIntensityDto } from '@shared/types'
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
  keepAwakeMode: Ref<KeepAwakeMode>
  brakeDuration: Ref<BrakeDurationDto>
  brakeCurve: Ref<BrakeCurveDto>
  backspinDuration: Ref<BackspinDurationDto>
  backspinIntensity: Ref<BackspinIntensityDto>
  loggingEnabled: Ref<boolean>
  devToolsEnabled: Ref<boolean>
  logDirectory: Ref<string>
  toastsEnabled: Ref<boolean>
  followPlayback: Ref<boolean>
  showLibraryTileImages: Ref<boolean>
  matchProjectTempoOnDrop: Ref<boolean>
  cleanupProjectFiles: Ref<boolean>
  skipButtonTarget: Ref<SkipButtonTarget>
  waveformDisplayMode: Ref<WaveformDisplayMode>
  defaultProjectSampleRate: Ref<number>
  defaultProjectDir: Ref<string>
  defaultClipDir: Ref<string>
  autosaveEnabled: Ref<boolean>
  autosaveIntervalSeconds: Ref<number>
  useGpuForStems: Ref<boolean>
  useBackupModel: Ref<boolean>
  enhanceVocals: Ref<boolean>
  vocalEnhanceStrength: Ref<VocalEnhanceStrength>
  enhanceDrums: Ref<boolean>
  drumEnhanceStrength: Ref<DrumEnhanceStrength>
  enhanceBass: Ref<boolean>
  bassEnhanceStrength: Ref<BassEnhanceStrength>
  enhanceOther: Ref<boolean>
  otherEnhanceStrength: Ref<OtherEnhanceStrength>
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
  const brakeSettings = useBrakeSettingsStore()
  const backspinSettings = useBackspinSettingsStore()
  const uniqueDevices = useUniqueAudioDevices()

  // Pending audio output; `null/null` means system default.
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

  // Auto-pick the preferred backend only when switching devices.
  function pickDevice(device: UniqueDevice): void {
    if (audioOutputDeviceName.value?.toLowerCase() === device.name.toLowerCase()) return
    audioOutputDeviceName.value = device.name
    audioOutputTypeName.value = preferredBackendFor(device)
  }

  function pickSystemDefault(): void {
    audioOutputDeviceName.value = null
    audioOutputTypeName.value = null
  }

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

  // Hidden by default to avoid exposing duplicate driver backends.
  const showAdvancedBackend = ref(false)

  function pickBackend(typeName: string): void {
    audioOutputTypeName.value = typeName
  }

  const keepAwakeMode = ref<KeepAwakeMode>('auto')
  const initialKeepAwakeMode = ref<KeepAwakeMode>('auto')

  const brakeDuration = ref<BrakeDurationDto>('medium')
  const brakeCurve = ref<BrakeCurveDto>('curved')
  const initialBrakeDuration = ref<BrakeDurationDto>('medium')
  const initialBrakeCurve = ref<BrakeCurveDto>('curved')

  const backspinDuration = ref<BackspinDurationDto>('long')
  const backspinIntensity = ref<BackspinIntensityDto>('medium')
  const initialBackspinDuration = ref<BackspinDurationDto>('long')
  const initialBackspinIntensity = ref<BackspinIntensityDto>('medium')

  const loggingEnabled = ref(false)
  const devToolsEnabled = ref(false)
  const logDirectory = ref('')
  const toastsEnabled = ref(true)
  const followPlayback = ref(true)
  const showLibraryTileImages = ref(true)
  const matchProjectTempoOnDrop = ref(true)
  const cleanupProjectFiles = ref(false)
  const skipButtonTarget = ref<SkipButtonTarget>('timelineEnds')
  const waveformDisplayMode = ref<WaveformDisplayMode>('summary')
  const defaultProjectSampleRate = ref<number>(44100)
  const defaultProjectDir = ref('')
  const defaultClipDir = ref('')
  const autosaveEnabled = ref(true)
  const autosaveIntervalSeconds = ref(30)
  const useGpuForStems = ref(false)
  const useBackupModel = ref(false)
  const enhanceVocals = ref(false)
  const vocalEnhanceStrength = ref<VocalEnhanceStrength>('medium')
  const enhanceDrums = ref(false)
  const drumEnhanceStrength = ref<DrumEnhanceStrength>('medium')
  const enhanceBass = ref(false)
  const bassEnhanceStrength = ref<BassEnhanceStrength>('medium')
  const enhanceOther = ref(false)
  const otherEnhanceStrength = ref<OtherEnhanceStrength>('medium')

  // Opening snapshot for change detection and restart notices.
  const initialLoggingEnabled = ref(false)
  const initialDevToolsEnabled = ref(false)
  const initialLogDirectory = ref('')
  const initialToasts = ref(true)
  const initialFollow = ref(true)
  const initialShowLibraryTileImages = ref(true)
  const initialMatchProjectTempoOnDrop = ref(true)
  const initialCleanupProjectFiles = ref(false)
  const initialSkipButtonTarget = ref<SkipButtonTarget>('timelineEnds')
  const initialWaveformDisplayMode = ref<WaveformDisplayMode>('summary')
  const initialDefaultProjectSampleRate = ref<number>(44100)
  const initialProjectDir = ref('')
  const initialClipDir = ref('')
  const initialAutosaveEnabled = ref(true)
  const initialAutosaveSeconds = ref(30)
  const initialUseGpuForStems = ref(false)
  const initialUseBackupModel = ref(false)
  const initialEnhanceVocals = ref(false)
  const initialVocalEnhanceStrength = ref<VocalEnhanceStrength>('medium')
  const initialEnhanceDrums = ref(false)
  const initialDrumEnhanceStrength = ref<DrumEnhanceStrength>('medium')
  const initialEnhanceBass = ref(false)
  const initialBassEnhanceStrength = ref<BassEnhanceStrength>('medium')
  const initialEnhanceOther = ref(false)
  const initialOtherEnhanceStrength = ref<OtherEnhanceStrength>('medium')

  const hasChanges = computed(
    () =>
      loggingEnabled.value !== initialLoggingEnabled.value ||
      devToolsEnabled.value !== initialDevToolsEnabled.value ||
      logDirectory.value !== initialLogDirectory.value ||
      toastsEnabled.value !== initialToasts.value ||
      followPlayback.value !== initialFollow.value ||
      showLibraryTileImages.value !== initialShowLibraryTileImages.value ||
      matchProjectTempoOnDrop.value !== initialMatchProjectTempoOnDrop.value ||
      cleanupProjectFiles.value !== initialCleanupProjectFiles.value ||
      skipButtonTarget.value !== initialSkipButtonTarget.value ||
      waveformDisplayMode.value !== initialWaveformDisplayMode.value ||
      defaultProjectSampleRate.value !== initialDefaultProjectSampleRate.value ||
      defaultProjectDir.value !== initialProjectDir.value ||
      defaultClipDir.value !== initialClipDir.value ||
      autosaveEnabled.value !== initialAutosaveEnabled.value ||
      autosaveIntervalSeconds.value !== initialAutosaveSeconds.value ||
      useGpuForStems.value !== initialUseGpuForStems.value ||
      useBackupModel.value !== initialUseBackupModel.value ||
      enhanceVocals.value !== initialEnhanceVocals.value ||
      vocalEnhanceStrength.value !== initialVocalEnhanceStrength.value ||
      enhanceDrums.value !== initialEnhanceDrums.value ||
      drumEnhanceStrength.value !== initialDrumEnhanceStrength.value ||
      enhanceBass.value !== initialEnhanceBass.value ||
      bassEnhanceStrength.value !== initialBassEnhanceStrength.value ||
      enhanceOther.value !== initialEnhanceOther.value ||
      otherEnhanceStrength.value !== initialOtherEnhanceStrength.value ||
      audioOutputTypeName.value !== initialAudioOutputTypeName.value ||
      audioOutputDeviceName.value !== initialAudioOutputDeviceName.value ||
      keepAwakeMode.value !== initialKeepAwakeMode.value ||
      brakeDuration.value !== initialBrakeDuration.value ||
      brakeCurve.value !== initialBrakeCurve.value ||
      backspinDuration.value !== initialBackspinDuration.value ||
      backspinIntensity.value !== initialBackspinIntensity.value
  )

  async function loadCurrent(): Promise<void> {
    try {
      const [debugVal, qol, autosave, audioPref, keepAwake] = await Promise.all([
        window.silverdaw.getDebugPreferences(),
        window.silverdaw.getQolPrefs(),
        window.silverdaw.getAutosaveConfig(),
        window.silverdaw.getAudioOutput(),
        window.silverdaw.getKeepAwakeMode()
      ])
      loggingEnabled.value = debugVal.loggingEnabled
      devToolsEnabled.value = debugVal.devToolsEnabled
      logDirectory.value = debugVal.logDirectory
      toastsEnabled.value = qol.toasts.enabled
      defaultProjectDir.value = qol.paths.defaultProjectDir
      defaultClipDir.value = qol.paths.defaultClipDir
      autosaveEnabled.value = autosave.enabled
      autosaveIntervalSeconds.value = autosave.intervalSeconds
      // Seed from the saved preference, not the live device JUCE chose.
      audioOutputTypeName.value = audioPref.typeName
      audioOutputDeviceName.value = audioPref.deviceName
      keepAwakeMode.value = keepAwake
      const brakePrefs = await window.silverdaw.getBrakeSettings()
      brakeDuration.value = brakePrefs.duration
      brakeCurve.value = brakePrefs.curve
      const backspinPrefs = await window.silverdaw.getBackspinSettings()
      backspinDuration.value = backspinPrefs.duration
      backspinIntensity.value = backspinPrefs.intensity
      const stemPrefs = await window.silverdaw.getStemPrefs()
      useGpuForStems.value = stemPrefs.useGpu
      useBackupModel.value = stemPrefs.useBackupModel
      enhanceVocals.value = stemPrefs.enhanceVocals
      vocalEnhanceStrength.value = stemPrefs.vocalEnhanceStrength
      enhanceDrums.value = stemPrefs.enhanceDrums
      drumEnhanceStrength.value = stemPrefs.drumEnhanceStrength
      enhanceBass.value = stemPrefs.enhanceBass
      bassEnhanceStrength.value = stemPrefs.bassEnhanceStrength
      enhanceOther.value = stemPrefs.enhanceOther
      otherEnhanceStrength.value = stemPrefs.otherEnhanceStrength
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
      keepAwakeMode.value = 'auto'
      brakeDuration.value = 'medium'
      brakeCurve.value = 'curved'
      backspinDuration.value = 'long'
      backspinIntensity.value = 'medium'
      useGpuForStems.value = false
      useBackupModel.value = false
      enhanceVocals.value = false
      vocalEnhanceStrength.value = 'medium'
      enhanceDrums.value = false
      drumEnhanceStrength.value = 'medium'
      enhanceBass.value = false
      bassEnhanceStrength.value = 'medium'
      enhanceOther.value = false
      otherEnhanceStrength.value = 'medium'
    }
    // UI prefs are already mirrored into uiStore at startup.
    followPlayback.value = ui.followPlayback
    showLibraryTileImages.value = ui.showLibraryTileImages
    matchProjectTempoOnDrop.value = ui.matchProjectTempoOnDrop
    cleanupProjectFiles.value = ui.cleanupProjectFiles
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
    initialCleanupProjectFiles.value = cleanupProjectFiles.value
    initialSkipButtonTarget.value = skipButtonTarget.value
    initialWaveformDisplayMode.value = waveformDisplayMode.value
    initialDefaultProjectSampleRate.value = defaultProjectSampleRate.value
    initialProjectDir.value = defaultProjectDir.value
    initialClipDir.value = defaultClipDir.value
    initialAutosaveEnabled.value = autosaveEnabled.value
    initialAutosaveSeconds.value = autosaveIntervalSeconds.value
    initialUseGpuForStems.value = useGpuForStems.value
    initialUseBackupModel.value = useBackupModel.value
    initialEnhanceVocals.value = enhanceVocals.value
    initialVocalEnhanceStrength.value = vocalEnhanceStrength.value
    initialEnhanceDrums.value = enhanceDrums.value
    initialDrumEnhanceStrength.value = drumEnhanceStrength.value
    initialEnhanceBass.value = enhanceBass.value
    initialBassEnhanceStrength.value = bassEnhanceStrength.value
    initialEnhanceOther.value = enhanceOther.value
    initialOtherEnhanceStrength.value = otherEnhanceStrength.value
    initialAudioOutputTypeName.value = audioOutputTypeName.value
    initialAudioOutputDeviceName.value = audioOutputDeviceName.value
    initialKeepAwakeMode.value = keepAwakeMode.value
    initialBrakeDuration.value = brakeDuration.value
    initialBrakeCurve.value = brakeCurve.value
    initialBackspinDuration.value = backspinDuration.value
    initialBackspinIntensity.value = backspinIntensity.value
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
    // Push only deltas; mirror toast changes locally immediately.
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
      ui.setFollowPlayback(followPlayback.value)
    }
    if (showLibraryTileImages.value !== initialShowLibraryTileImages.value) {
      ui.setShowLibraryTileImages(showLibraryTileImages.value)
    }
    if (matchProjectTempoOnDrop.value !== initialMatchProjectTempoOnDrop.value) {
      ui.setMatchProjectTempoOnDrop(matchProjectTempoOnDrop.value)
    }
    if (cleanupProjectFiles.value !== initialCleanupProjectFiles.value) {
      ui.setCleanupProjectFiles(cleanupProjectFiles.value)
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
    // Mirror autosave locally so its watcher reacts without re-hydrate.
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
    // Persist audio output only after the backend accepts the selection.
    if (
      audioOutputTypeName.value !== initialAudioOutputTypeName.value ||
      audioOutputDeviceName.value !== initialAudioOutputDeviceName.value
    ) {
      audioDevices.selectDevice(audioOutputTypeName.value, audioOutputDeviceName.value)
    }
    if (keepAwakeMode.value !== initialKeepAwakeMode.value) {
      audioDevices.setKeepAwakeMode(keepAwakeMode.value)
    }
    if (
      brakeDuration.value !== initialBrakeDuration.value ||
      brakeCurve.value !== initialBrakeCurve.value
    ) {
      brakeSettings.setBrakeSettings(brakeDuration.value, brakeCurve.value)
    }
    if (
      backspinDuration.value !== initialBackspinDuration.value ||
      backspinIntensity.value !== initialBackspinIntensity.value
    ) {
      backspinSettings.setBackspinSettings(backspinDuration.value, backspinIntensity.value)
    }
    if (useGpuForStems.value !== initialUseGpuForStems.value) {
      window.silverdaw.setStemPrefs({ useGpu: useGpuForStems.value })
    }
    if (useBackupModel.value !== initialUseBackupModel.value) {
      window.silverdaw.setStemPrefs({ useBackupModel: useBackupModel.value })
    }
    if (
      enhanceVocals.value !== initialEnhanceVocals.value ||
      vocalEnhanceStrength.value !== initialVocalEnhanceStrength.value
    ) {
      window.silverdaw.setStemPrefs({
        enhanceVocals: enhanceVocals.value,
        vocalEnhanceStrength: vocalEnhanceStrength.value
      })
    }
    if (
      enhanceDrums.value !== initialEnhanceDrums.value ||
      drumEnhanceStrength.value !== initialDrumEnhanceStrength.value
    ) {
      window.silverdaw.setStemPrefs({
        enhanceDrums: enhanceDrums.value,
        drumEnhanceStrength: drumEnhanceStrength.value
      })
    }
    if (
      enhanceBass.value !== initialEnhanceBass.value ||
      bassEnhanceStrength.value !== initialBassEnhanceStrength.value
    ) {
      window.silverdaw.setStemPrefs({
        enhanceBass: enhanceBass.value,
        bassEnhanceStrength: bassEnhanceStrength.value
      })
    }
    if (
      enhanceOther.value !== initialEnhanceOther.value ||
      otherEnhanceStrength.value !== initialOtherEnhanceStrength.value
    ) {
      window.silverdaw.setStemPrefs({
        enhanceOther: enhanceOther.value,
        otherEnhanceStrength: otherEnhanceStrength.value
      })
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
    keepAwakeMode,
    brakeDuration,
    brakeCurve,
    backspinDuration,
    backspinIntensity,
    loggingEnabled,
    devToolsEnabled,
    logDirectory,
    toastsEnabled,
    followPlayback,
    showLibraryTileImages,
    matchProjectTempoOnDrop,
    cleanupProjectFiles,
    skipButtonTarget,
    waveformDisplayMode,
    defaultProjectSampleRate,
    defaultProjectDir,
    defaultClipDir,
    autosaveEnabled,
    autosaveIntervalSeconds,
    useGpuForStems,
    useBackupModel,
    enhanceVocals,
    vocalEnhanceStrength,
    enhanceDrums,
    drumEnhanceStrength,
    enhanceBass,
    bassEnhanceStrength,
    enhanceOther,
    otherEnhanceStrength,
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
