<script setup lang="ts">
// Preferences dialog. Transactional: edits are held locally until Save; Cancel
// and Esc discard.

import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { usePreferencesForm } from '@/lib/preferences/usePreferencesForm'
import PreferencesAudioTab from './PreferencesAudioTab.vue'
import PreferencesDeveloperTab from './PreferencesDeveloperTab.vue'
import PreferencesEffectsTab from './PreferencesEffectsTab.vue'
import PreferencesGeneralTab from './PreferencesGeneralTab.vue'
import PreferencesProjectTab from './PreferencesProjectTab.vue'
import PreferencesTimelineTab from './PreferencesTimelineTab.vue'
import PreferencesStemsTab from './PreferencesStemsTab.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const audioDevices = useAudioDeviceStore()

const {
  uniqueDevices,
  audioOutputTypeName,
  isAudioOutputSelectedDevice,
  pickDevice,
  backendsForSelectedDevice,
  showAdvancedBackend,
  pickBackend,
  keepAwakeByDeviceDraft,
  setDeviceKeepAwake,
  loggingEnabled,
  devToolsEnabled,
  logDirectory,
  toastsEnabled,
  followPlayback,
  showLibraryTileImages,
  matchProjectTempoOnDrop,
  seedProjectTempoFromFirstClip,
  cleanupProjectFiles,
  skipButtonTarget,
  waveformDisplayMode,
  brakeDuration,
  brakeCurve,
  backspinDuration,
  backspinIntensity,
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
} = usePreferencesForm()

const dialogEl = ref<HTMLDivElement | null>(null)

type PreferencesTab = 'general' | 'timeline' | 'project' | 'audio' | 'effects' | 'stems' | 'developer'
const activeTab = ref<PreferencesTab>('general')

const tabs: Array<{ id: PreferencesTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'project', label: 'Project' },
  { id: 'audio', label: 'Audio' },
  { id: 'effects', label: 'Effects' },
  { id: 'stems', label: 'Stems' },
  { id: 'developer', label: 'Developer' }
]

function onKeyDown(e: KeyboardEvent): void {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
})

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return
    activeTab.value = 'general'
    showAdvancedBackend.value = false
    await loadCurrent()
    requestAnimationFrame(() => dialogEl.value?.focus())
  }
)

function onCancel(): void {
  emit('close')
}

function onSave(): void {
  save()
  emit('close')
}
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-100"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefs-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(720px,94vw)]"
      >
        <div class="dialog-header">
          <h1
            id="prefs-title"
            class="dialog-title"
          >
            Preferences
          </h1>
        </div>

        <div class="flex h-[70vh] overflow-hidden">
          <nav
            class="flex w-40 shrink-0 flex-col gap-0.5 border-r border-zinc-800 bg-zinc-950/40 py-3 text-xs"
            role="tablist"
            aria-orientation="vertical"
          >
            <button
              v-for="tab in tabs"
              :key="tab.id"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.id"
              data-borderless-button="true"
              :class="[
                'mx-2 rounded px-3 py-1.5 text-left',
                activeTab === tab.id
                  ? 'bg-sky-600/20 text-sky-200'
                  : 'text-zinc-300 hover:bg-zinc-800'
              ]"
              @click="activeTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </nav>

          <div
            class="silverdaw-scroll flex-1 overflow-y-auto px-6 py-5 text-xs leading-relaxed"
            role="tabpanel"
          >
            <PreferencesGeneralTab
              v-if="activeTab === 'general'"
              v-model:toasts-enabled="toastsEnabled"
              v-model:show-library-tile-images="showLibraryTileImages"
              v-model:waveform-display-mode="waveformDisplayMode"
            />
            <PreferencesTimelineTab
              v-else-if="activeTab === 'timeline'"
              v-model:follow-playback="followPlayback"
              v-model:match-project-tempo-on-drop="matchProjectTempoOnDrop"
              v-model:seed-project-tempo-from-first-clip="seedProjectTempoFromFirstClip"
              v-model:skip-button-target="skipButtonTarget"
            />
            <PreferencesEffectsTab
              v-else-if="activeTab === 'effects'"
              v-model:brake-duration="brakeDuration"
              v-model:brake-curve="brakeCurve"
              v-model:backspin-duration="backspinDuration"
              v-model:backspin-intensity="backspinIntensity"
            />
            <PreferencesProjectTab
              v-else-if="activeTab === 'project'"
              v-model:autosave-enabled="autosaveEnabled"
              v-model:autosave-interval-seconds="autosaveIntervalSeconds"
              v-model:cleanup-project-files="cleanupProjectFiles"
              :default-project-dir="defaultProjectDir"
              :default-clip-dir="defaultClipDir"
              :choose-project-dir="chooseProjectDir"
              :choose-clip-dir="chooseClipDir"
            />
            <PreferencesAudioTab
              v-else-if="activeTab === 'audio'"
              v-model:default-project-sample-rate="defaultProjectSampleRate"
              v-model:show-advanced-backend="showAdvancedBackend"
              :keep-awake-by-device="keepAwakeByDeviceDraft"
              :set-device-keep-awake="setDeviceKeepAwake"
              :unique-devices="uniqueDevices"
              :audio-output-type-name="audioOutputTypeName"
              :is-audio-output-selected-device="isAudioOutputSelectedDevice"
              :pick-device="pickDevice"
              :backends-for-selected-device="backendsForSelectedDevice"
              :pick-backend="pickBackend"
              :audio-devices-hydrated="audioDevices.hydrated"
              :rescanning="audioDevices.rescanning"
              :last-error="audioDevices.lastError"
              :request-rescan="audioDevices.requestRescan"
            />
            <PreferencesStemsTab
              v-else-if="activeTab === 'stems'"
              v-model:use-gpu-for-stems="useGpuForStems"
              v-model:use-backup-model="useBackupModel"
              v-model:enhance-vocals="enhanceVocals"
              v-model:vocal-enhance-strength="vocalEnhanceStrength"
              v-model:enhance-drums="enhanceDrums"
              v-model:drum-enhance-strength="drumEnhanceStrength"
              v-model:enhance-bass="enhanceBass"
              v-model:bass-enhance-strength="bassEnhanceStrength"
              v-model:enhance-other="enhanceOther"
              v-model:other-enhance-strength="otherEnhanceStrength"
            />
            <PreferencesDeveloperTab
              v-else
              v-model:logging-enabled="loggingEnabled"
              v-model:dev-tools-enabled="devToolsEnabled"
              v-model:log-directory="logDirectory"
              :initial-logging-enabled="initialLoggingEnabled"
              :initial-dev-tools-enabled="initialDevToolsEnabled"
              :initial-log-directory="initialLogDirectory"
              :choose-log-dir="chooseLogDir"
            />
          </div>
        </div>

        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="onCancel"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            :disabled="!hasChanges"
            @click="onSave"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
