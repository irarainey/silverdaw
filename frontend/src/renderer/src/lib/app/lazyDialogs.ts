import { defineAsyncComponent } from 'vue'

export const ImportProgressDialog = defineAsyncComponent(
  () => import('@/components/ImportProgressDialog.vue')
)
export const AboutDialog = defineAsyncComponent(() => import('@/components/AboutDialog.vue'))
export const PreferencesDialog = defineAsyncComponent(
  () => import('@/components/PreferencesDialog.vue')
)
export const MidiMonitorDialog = defineAsyncComponent(
  () => import('@/components/MidiMonitorDialog.vue')
)
export const ProjectPropertiesDialog = defineAsyncComponent(
  () => import('@/components/ProjectPropertiesDialog.vue')
)
export const ExportMixdownDialog = defineAsyncComponent(
  () => import('@/components/ExportMixdownDialog.vue')
)
export const MixdownProgressDialog = defineAsyncComponent(
  () => import('@/components/MixdownProgressDialog.vue')
)
export const StemSelectionDialog = defineAsyncComponent(
  () => import('@/components/StemSelectionDialog.vue')
)
export const StemModelDownloadDialog = defineAsyncComponent(
  () => import('@/components/StemModelDownloadDialog.vue')
)
export const StemSeparationProgressDialog = defineAsyncComponent(
  () => import('@/components/StemSeparationProgressDialog.vue')
)
export const ChannelSplitDialog = defineAsyncComponent(
  () => import('@/components/ChannelSplitDialog.vue')
)
export const AudioDeviceUnavailableDialog = defineAsyncComponent(
  () => import('@/components/AudioDeviceUnavailableDialog.vue')
)
export const SampleRateMismatchDialog = defineAsyncComponent(
  () => import('@/components/SampleRateMismatchDialog.vue')
)
export const UnsavedChangesDialog = defineAsyncComponent(
  () => import('@/components/UnsavedChangesDialog.vue')
)
export const RelinkDialog = defineAsyncComponent(() => import('@/components/RelinkDialog.vue'))
