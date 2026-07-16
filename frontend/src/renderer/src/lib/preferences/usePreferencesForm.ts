// Transactional form model for PreferencesDialog; nothing persists until `save()`.
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { VocalEnhanceStrength, DrumEnhanceStrength, BassEnhanceStrength, OtherEnhanceStrength } from '@shared/bridge-protocol'
import { useAppStore } from '@/stores/appStore'
import { useUiStore, type SkipButtonTarget, type WaveformDisplayMode } from '@/stores/uiStore'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useMidiDeviceStore } from '@/stores/midiDeviceStore'
import { useBrakeSettingsStore } from '@/stores/brakeSettingsStore'
import { useBackspinSettingsStore } from '@/stores/backspinSettingsStore'
import { useScratchRealismSettingsStore } from '@/stores/scratchRealismSettingsStore'
import { useScratchInputSettingsStore } from '@/stores/scratchInputSettingsStore'
import { log } from '@/lib/log'
import { DEFAULT_MIDI_DEVICE_PREFERENCES } from '@shared/types'
import type {
  BackspinDurationDto,
  BackspinIntensityDto,
  BrakeCurveDto,
  BrakeDurationDto,
  MidiCrossfaderDirection,
  MidiDefaultDeck,
  MidiDevicePreferences,
  ScratchRealismLevelDto,
  ScratchCrossfaderCutKeyDto
} from '@shared/types'
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
  isAudioOutputSelectedDevice: (deviceName: string) => boolean
  pickDevice: (device: UniqueDevice) => void
  backendsForSelectedDevice: ComputedRef<string[]>
  showAdvancedBackend: Ref<boolean>
  pickBackend: (typeName: string) => void
  /** Draft per-device keep-awake toggles (device name → true); absent = off. */
  keepAwakeByDeviceDraft: Ref<Record<string, boolean>>
  /** Enable / disable a device's draft keep-awake toggle. */
  setDeviceKeepAwake: (deviceName: string, enabled: boolean) => void
  enabledMidiInputsDraft: Ref<Record<string, boolean>>
  setMidiInputEnabled: (identifier: string, enabled: boolean) => void
  midiDevicePreferencesDraft: Ref<Record<string, MidiDevicePreferences>>
  setMidiScrubAudio: (identifier: string, enabled: boolean) => void
  setMidiCrossfaderDirection: (
    identifier: string,
    direction: MidiCrossfaderDirection
  ) => void
  setMidiDefaultDeck: (identifier: string, defaultDeck: MidiDefaultDeck) => void
  discardMidiInputChanges: () => void
  brakeDuration: Ref<BrakeDurationDto>
  brakeCurve: Ref<BrakeCurveDto>
  backspinDuration: Ref<BackspinDurationDto>
  backspinIntensity: Ref<BackspinIntensityDto>
  scratchRealismLevel: Ref<ScratchRealismLevelDto>
  scratchCrossfaderCutKey: Ref<ScratchCrossfaderCutKeyDto>
  loggingEnabled: Ref<boolean>
  devToolsEnabled: Ref<boolean>
  logDirectory: Ref<string>
  toastsEnabled: Ref<boolean>
  followPlayback: Ref<boolean>
  showLibraryTileImages: Ref<boolean>
  matchProjectTempoOnDrop: Ref<boolean>
  seedProjectTempoFromFirstClip: Ref<boolean>
  alignClipsToGridOnAnalysis: Ref<boolean>
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
  save: () => Promise<void>
}

export function usePreferencesForm(): PreferencesForm {
  const appStore = useAppStore()
  const ui = useUiStore()
  const audioDevices = useAudioDeviceStore()
  const midiDevices = useMidiDeviceStore()
  const brakeSettings = useBrakeSettingsStore()
  const backspinSettings = useBackspinSettingsStore()
  const scratchRealismSettings = useScratchRealismSettingsStore()
  const scratchInputSettings = useScratchInputSettingsStore()
  const uniqueDevices = useUniqueAudioDevices()

  // Pending audio output; `null/null` means system default.
  const audioOutputTypeName = ref<string | null>(null)
  const audioOutputDeviceName = ref<string | null>(null)
  const initialAudioOutputTypeName = ref<string | null>(null)
  const initialAudioOutputDeviceName = ref<string | null>(null)

  // Effective selection = the pending device if it's currently available; otherwise
  // (nothing pinned, or the preferred device is unplugged) the physically-open device
  // the backend fell back to. So the list always shows a real, checked device.
  function isAudioOutputSelectedDevice(deviceName: string): boolean {
    const draft = audioOutputDeviceName.value
    const draftAvailable =
      !!draft && uniqueDevices.value.some((d) => d.name.toLowerCase() === draft.toLowerCase())
    const effective = draftAvailable ? draft : audioDevices.currentDeviceName
    return !!effective && effective.toLowerCase() === deviceName.toLowerCase()
  }

  // Auto-pick the preferred backend only when switching devices.
  function pickDevice(device: UniqueDevice): void {
    if (audioOutputDeviceName.value?.toLowerCase() === device.name.toLowerCase()) return
    audioOutputDeviceName.value = device.name
    audioOutputTypeName.value = preferredBackendFor(device)
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

  const keepAwakeByDeviceDraft = ref<Record<string, boolean>>({})
  const initialKeepAwakeByDevice = ref<Record<string, boolean>>({})

  // Compare the draft map against the initial, treating an absent entry as off.
  function keepAwakeMapChanged(): boolean {
    const a = keepAwakeByDeviceDraft.value
    const b = initialKeepAwakeByDevice.value
    const names = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const name of names) {
      if ((a[name] ?? false) !== (b[name] ?? false)) return true
    }
    return false
  }

  function setDeviceKeepAwake(deviceName: string, enabled: boolean): void {
    const next = { ...keepAwakeByDeviceDraft.value }
    if (enabled) next[deviceName] = true
    else delete next[deviceName]
    keepAwakeByDeviceDraft.value = next
  }

  const enabledMidiInputsDraft = ref<Record<string, boolean>>({})
  const initialEnabledMidiInputs = ref<Record<string, boolean>>({})
  const midiDevicePreferencesDraft = ref<Record<string, MidiDevicePreferences>>({})
  const initialMidiDevicePreferences = ref<Record<string, MidiDevicePreferences>>({})

  function enabledMidiInputsChanged(): boolean {
    const draft = enabledMidiInputsDraft.value
    const initial = initialEnabledMidiInputs.value
    const identifiers = new Set([...Object.keys(draft), ...Object.keys(initial)])
    for (const identifier of identifiers) {
      if ((draft[identifier] ?? false) !== (initial[identifier] ?? false)) return true
    }
    return false
  }

  function setMidiInputEnabled(identifier: string, enabled: boolean): void {
    const next = { ...enabledMidiInputsDraft.value }
    if (enabled) next[identifier] = true
    else delete next[identifier]
    enabledMidiInputsDraft.value = next
  }

  function effectiveMidiDevicePreferences(
    source: Record<string, MidiDevicePreferences>,
    identifier: string
  ): MidiDevicePreferences {
    return source[identifier] ?? {
      ...DEFAULT_MIDI_DEVICE_PREFERENCES
    }
  }

  function midiDevicePreferencesChanged(): boolean {
    const draft = midiDevicePreferencesDraft.value
    const initial = initialMidiDevicePreferences.value
    const identifiers = new Set([...Object.keys(draft), ...Object.keys(initial)])
    for (const identifier of identifiers) {
      const next = effectiveMidiDevicePreferences(draft, identifier)
      const previous = effectiveMidiDevicePreferences(initial, identifier)
      if (
        next.scrubAudioEnabled !== previous.scrubAudioEnabled ||
        next.crossfaderDirection !== previous.crossfaderDirection ||
        next.defaultDeck !== previous.defaultDeck
      ) {
        return true
      }
    }
    return false
  }

  function setMidiScrubAudio(identifier: string, enabled: boolean): void {
    const current = effectiveMidiDevicePreferences(midiDevicePreferencesDraft.value, identifier)
    midiDevicePreferencesDraft.value = {
      ...midiDevicePreferencesDraft.value,
      [identifier]: { ...current, scrubAudioEnabled: enabled }
    }
  }

  function setMidiCrossfaderDirection(
    identifier: string,
    direction: MidiCrossfaderDirection
  ): void {
    const current = effectiveMidiDevicePreferences(midiDevicePreferencesDraft.value, identifier)
    midiDevicePreferencesDraft.value = {
      ...midiDevicePreferencesDraft.value,
      [identifier]: { ...current, crossfaderDirection: direction }
    }
  }

  function setMidiDefaultDeck(identifier: string, defaultDeck: MidiDefaultDeck): void {
    const current = effectiveMidiDevicePreferences(midiDevicePreferencesDraft.value, identifier)
    midiDevicePreferencesDraft.value = {
      ...midiDevicePreferencesDraft.value,
      [identifier]: { ...current, defaultDeck }
    }
  }

  function discardMidiInputChanges(): void {
    enabledMidiInputsDraft.value = { ...initialEnabledMidiInputs.value }
    midiDevicePreferencesDraft.value = { ...initialMidiDevicePreferences.value }
    midiDevices.applyEnabledInputs(initialEnabledMidiInputs.value)
  }

  const brakeDuration = ref<BrakeDurationDto>('medium')
  const brakeCurve = ref<BrakeCurveDto>('curved')
  const initialBrakeDuration = ref<BrakeDurationDto>('medium')
  const initialBrakeCurve = ref<BrakeCurveDto>('curved')

  const backspinDuration = ref<BackspinDurationDto>('long')
  const backspinIntensity = ref<BackspinIntensityDto>('medium')
  const initialBackspinDuration = ref<BackspinDurationDto>('long')
  const initialBackspinIntensity = ref<BackspinIntensityDto>('medium')

  const scratchRealismLevel = ref<ScratchRealismLevelDto>('medium')
  const initialScratchRealismLevel = ref<ScratchRealismLevelDto>('medium')

  const scratchCrossfaderCutKey = ref<ScratchCrossfaderCutKeyDto>('KeyZ')
  const initialScratchCrossfaderCutKey = ref<ScratchCrossfaderCutKeyDto>('KeyZ')

  const loggingEnabled = ref(false)
  const devToolsEnabled = ref(false)
  const logDirectory = ref('')
  const toastsEnabled = ref(true)
  const followPlayback = ref(true)
  const showLibraryTileImages = ref(true)
  const matchProjectTempoOnDrop = ref(true)
  const seedProjectTempoFromFirstClip = ref(true)
  const alignClipsToGridOnAnalysis = ref(true)
  const cleanupProjectFiles = ref(false)
  const skipButtonTarget = ref<SkipButtonTarget>('markers')
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
  const initialSeedProjectTempoFromFirstClip = ref(true)
  const initialAlignClipsToGridOnAnalysis = ref(true)
  const initialCleanupProjectFiles = ref(false)
  const initialSkipButtonTarget = ref<SkipButtonTarget>('markers')
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
      seedProjectTempoFromFirstClip.value !== initialSeedProjectTempoFromFirstClip.value ||
      alignClipsToGridOnAnalysis.value !== initialAlignClipsToGridOnAnalysis.value ||
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
      keepAwakeMapChanged() ||
      enabledMidiInputsChanged() ||
      midiDevicePreferencesChanged() ||
      brakeDuration.value !== initialBrakeDuration.value ||
      brakeCurve.value !== initialBrakeCurve.value ||
      backspinDuration.value !== initialBackspinDuration.value ||
      backspinIntensity.value !== initialBackspinIntensity.value ||
      scratchRealismLevel.value !== initialScratchRealismLevel.value ||
      scratchCrossfaderCutKey.value !== initialScratchCrossfaderCutKey.value
  )

  async function loadCurrent(): Promise<void> {
    const stemPrefsLoad = window.silverdaw
      .getStemPrefs()
      .then((stemPrefs) => {
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
        log.info(
          'preferences',
          `loaded stem cleanup vocals=${stemPrefs.enhanceVocals} drums=${stemPrefs.enhanceDrums} ` +
            `bass=${stemPrefs.enhanceBass} other=${stemPrefs.enhanceOther}`
        )
      })
      .catch((err) => {
        log.error(
          'preferences',
          `stem cleanup load failed: ${err instanceof Error ? err.message : String(err)}`
        )
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
      })

    try {
      const [
        debugVal,
        qol,
        autosave,
        audioPref,
        keepAwakeByDevice,
        enabledMidiInputs,
        midiDevicePreferences
      ] = await Promise.all([
        window.silverdaw.getDebugPreferences(),
        window.silverdaw.getQolPrefs(),
        window.silverdaw.getAutosaveConfig(),
        window.silverdaw.getAudioOutput(),
        window.silverdaw.getKeepAwakeByDevice(),
        window.silverdaw.getEnabledMidiInputs(),
        window.silverdaw.getMidiDevicePreferences()
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
      // Keep-awake is pinned per physical device; seed the draft map.
      audioDevices.keepAwakeByDevice = { ...keepAwakeByDevice }
      keepAwakeByDeviceDraft.value = { ...keepAwakeByDevice }
      enabledMidiInputsDraft.value = { ...enabledMidiInputs }
      midiDevicePreferencesDraft.value = { ...midiDevicePreferences }
      const brakePrefs = await window.silverdaw.getBrakeSettings()
      brakeDuration.value = brakePrefs.duration
      brakeCurve.value = brakePrefs.curve
      const backspinPrefs = await window.silverdaw.getBackspinSettings()
      backspinDuration.value = backspinPrefs.duration
      backspinIntensity.value = backspinPrefs.intensity
      scratchRealismLevel.value = (await window.silverdaw.getScratchRealismSettings()).level
      const scratchPrefs = await window.silverdaw.getScratchSettings()
      scratchCrossfaderCutKey.value = scratchPrefs.crossfaderCutKey
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
      keepAwakeByDeviceDraft.value = {}
      enabledMidiInputsDraft.value = {}
      midiDevicePreferencesDraft.value = {}
      brakeDuration.value = 'medium'
      brakeCurve.value = 'curved'
      backspinDuration.value = 'long'
      backspinIntensity.value = 'medium'
      scratchRealismLevel.value = 'medium'
    }

    await stemPrefsLoad
    // UI prefs are already mirrored into uiStore at startup.
    followPlayback.value = ui.followPlayback
    showLibraryTileImages.value = ui.showLibraryTileImages
    matchProjectTempoOnDrop.value = ui.matchProjectTempoOnDrop
    seedProjectTempoFromFirstClip.value = ui.seedProjectTempoFromFirstClip
    alignClipsToGridOnAnalysis.value = ui.alignClipsToGridOnAnalysis
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
    initialSeedProjectTempoFromFirstClip.value = seedProjectTempoFromFirstClip.value
    initialAlignClipsToGridOnAnalysis.value = alignClipsToGridOnAnalysis.value
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
    initialKeepAwakeByDevice.value = { ...keepAwakeByDeviceDraft.value }
    initialEnabledMidiInputs.value = { ...enabledMidiInputsDraft.value }
    initialMidiDevicePreferences.value = { ...midiDevicePreferencesDraft.value }
    initialBrakeDuration.value = brakeDuration.value
    initialBrakeCurve.value = brakeCurve.value
    initialBackspinDuration.value = backspinDuration.value
    initialBackspinIntensity.value = backspinIntensity.value
    initialScratchRealismLevel.value = scratchRealismLevel.value
    initialScratchCrossfaderCutKey.value = scratchCrossfaderCutKey.value
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

  async function save(): Promise<void> {
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
    if (seedProjectTempoFromFirstClip.value !== initialSeedProjectTempoFromFirstClip.value) {
      ui.setSeedProjectTempoFromFirstClip(seedProjectTempoFromFirstClip.value)
    }
    if (alignClipsToGridOnAnalysis.value !== initialAlignClipsToGridOnAnalysis.value) {
      ui.setAlignClipsToGridOnAnalysis(alignClipsToGridOnAnalysis.value)
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
    if (keepAwakeMapChanged()) {
      const draft = keepAwakeByDeviceDraft.value
      const initial = initialKeepAwakeByDevice.value
      const names = new Set([...Object.keys(draft), ...Object.keys(initial)])
      for (const name of names) {
        const next = draft[name] ?? false
        if (next !== (initial[name] ?? false)) audioDevices.setKeepAwakeForDevice(name, next)
      }
    }
    if (enabledMidiInputsChanged()) {
      const draft = enabledMidiInputsDraft.value
      const initial = initialEnabledMidiInputs.value
      const identifiers = new Set([...Object.keys(draft), ...Object.keys(initial)])
      for (const identifier of identifiers) {
        if ((draft[identifier] ?? false) !== (initial[identifier] ?? false)) {
          window.silverdaw.setMidiInputEnabled(identifier, draft[identifier] === true)
        }
      }
      midiDevices.applyEnabledInputs(draft)
    }
    if (midiDevicePreferencesChanged()) {
      const draft = midiDevicePreferencesDraft.value
      const initial = initialMidiDevicePreferences.value
      const identifiers = new Set([...Object.keys(draft), ...Object.keys(initial)])
      for (const identifier of identifiers) {
        const next = effectiveMidiDevicePreferences(draft, identifier)
        const previous = effectiveMidiDevicePreferences(initial, identifier)
        if (
          next.scrubAudioEnabled !== previous.scrubAudioEnabled ||
          next.crossfaderDirection !== previous.crossfaderDirection ||
          next.defaultDeck !== previous.defaultDeck
        ) {
          window.silverdaw.setMidiDevicePreferences(identifier, {
            scrubAudioEnabled: next.scrubAudioEnabled,
            crossfaderDirection: next.crossfaderDirection,
            defaultDeck: next.defaultDeck
          })
        }
      }
      midiDevices.applyDevicePreferences(draft)
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
    if (scratchRealismLevel.value !== initialScratchRealismLevel.value) {
      scratchRealismSettings.setScratchRealismLevel(scratchRealismLevel.value)
    }
    if (scratchCrossfaderCutKey.value !== initialScratchCrossfaderCutKey.value) {
      scratchInputSettings.setCrossfaderCutKey(scratchCrossfaderCutKey.value)
    }
    const stemPatch: Parameters<typeof window.silverdaw.setStemPrefs>[0] = {}
    if (useGpuForStems.value !== initialUseGpuForStems.value) {
      stemPatch.useGpu = useGpuForStems.value
    }
    if (useBackupModel.value !== initialUseBackupModel.value) {
      stemPatch.useBackupModel = useBackupModel.value
    }
    if (
      enhanceVocals.value !== initialEnhanceVocals.value ||
      vocalEnhanceStrength.value !== initialVocalEnhanceStrength.value
    ) {
      stemPatch.enhanceVocals = enhanceVocals.value
      stemPatch.vocalEnhanceStrength = vocalEnhanceStrength.value
    }
    if (
      enhanceDrums.value !== initialEnhanceDrums.value ||
      drumEnhanceStrength.value !== initialDrumEnhanceStrength.value
    ) {
      stemPatch.enhanceDrums = enhanceDrums.value
      stemPatch.drumEnhanceStrength = drumEnhanceStrength.value
    }
    if (
      enhanceBass.value !== initialEnhanceBass.value ||
      bassEnhanceStrength.value !== initialBassEnhanceStrength.value
    ) {
      stemPatch.enhanceBass = enhanceBass.value
      stemPatch.bassEnhanceStrength = bassEnhanceStrength.value
    }
    if (
      enhanceOther.value !== initialEnhanceOther.value ||
      otherEnhanceStrength.value !== initialOtherEnhanceStrength.value
    ) {
      stemPatch.enhanceOther = enhanceOther.value
      stemPatch.otherEnhanceStrength = otherEnhanceStrength.value
    }
    if (Object.keys(stemPatch).length > 0) await window.silverdaw.setStemPrefs(stemPatch)
  }

  return {
    uniqueDevices,
    audioOutputTypeName,
    audioOutputDeviceName,
    isAudioOutputSelectedDevice,
    pickDevice,
    backendsForSelectedDevice,
    showAdvancedBackend,
    pickBackend,
    keepAwakeByDeviceDraft,
    setDeviceKeepAwake,
    enabledMidiInputsDraft,
    setMidiInputEnabled,
    midiDevicePreferencesDraft,
    setMidiScrubAudio,
    setMidiCrossfaderDirection,
    setMidiDefaultDeck,
    discardMidiInputChanges,
    brakeDuration,
    brakeCurve,
    backspinDuration,
    backspinIntensity,
    scratchRealismLevel,
    scratchCrossfaderCutKey,
    loggingEnabled,
    devToolsEnabled,
    logDirectory,
    toastsEnabled,
    followPlayback,
    showLibraryTileImages,
    matchProjectTempoOnDrop,
    seedProjectTempoFromFirstClip,
    alignClipsToGridOnAnalysis,
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
