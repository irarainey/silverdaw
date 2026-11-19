<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { TrackExportStartSchema, type ExportFormat, type ExportBitDepth } from '@shared/bridge-protocol'
import { send } from '@/lib/bridgeService'
import { exportSampleRate } from '@/lib/export/exportSampleRate'
import { useExportBitDepths } from '@/lib/export/useExportBitDepths'
import { mergeExportSettings, readTrackExportPreferences } from '@/lib/export/projectExportSettings'
import ExportOutputLocation from './ExportOutputLocation.vue'
import ExportFormatSettings from './ExportFormatSettings.vue'
import ExportTrackPicker from './ExportTrackPicker.vue'
import { beginTrackExport } from '@/lib/mixdownState'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'

const props = defineProps<{ initialTrackId?: string }>()
const emit = defineEmits<{ close: [] }>()
const project = useProjectStore()
const notifications = useNotificationsStore()
const sampleRate = ref(exportSampleRate(project.targetSampleRate, useUiStore().defaultProjectSampleRate))
const preferences = readTrackExportPreferences(project.exportSettingsJson)
const format = ref<ExportFormat>(preferences.format ?? 'wav')
const bitDepth = ref<ExportBitDepth>(preferences.bitDepth ?? 24)
const bitrate = ref(preferences.bitrateKbps ?? 192)
const availableBitDepths = useExportBitDepths(format, bitDepth)
const includeEffects = ref(true)
const tailSeconds = ref(0)
const tailInput = ref<HTMLInputElement | null>(null)
const submitting = ref(false)
const card = ref<HTMLElement | null>(null)
const hasClips = computed(() => project.tracks.some(track => track.clipIds.length > 0))
const selection = ref(props.initialTrackId ? [props.initialTrackId] : preferences.trackIds)
const selectedTracks = computed(() => {
  const ids = selection.value && new Set(selection.value)
  return ids ? project.tracks.filter(track => ids.has(track.id)) : project.tracks
})
const selectedIds = computed({
  get: () => selectedTracks.value.map(track => track.id),
  set: (ids: string[]) => { selection.value = ids.length === project.tracks.length ? null : ids }
})
function exportFolder(path: string): string {
  return path.replace(/[^\\/]+$/, 'export')
}
const defaultFolder = computed(() => project.currentFilePath ? exportFolder(project.currentFilePath) : '')
const destination = ref(preferences.outputFolder ?? defaultFolder.value)
const customFolder = computed(() => destination.value === defaultFolder.value ? undefined : destination.value || undefined)
const settings = computed(() => TrackExportStartSchema.safeParse({
  format: format.value, sampleRate: sampleRate.value,
  ...(format.value === 'mp3' ? { bitrateKbps: bitrate.value } : { bitDepth: bitDepth.value }),
  includeEffects: includeEffects.value, tailSeconds: tailSeconds.value,
  outputFolder: customFolder.value,
  trackLabels: Object.fromEntries(selectedTracks.value.map(track => [track.id, track.name]))
}))
const invalidTail = computed(() => !settings.value.success && settings.value.error.issues.some(issue => issue.path[0] === 'tailSeconds'))

function stepTail(delta: number): void {
  const input = tailInput.value
  if (!input) return
  if (delta > 0) input.stepUp()
  else input.stepDown()
  tailSeconds.value = input.valueAsNumber
}

async function browse(): Promise<void> {
  try {
    const picked = await window.silverdaw.chooseDirectory({
      title: 'Choose Track Export Folder',
      defaultPath: destination.value || defaultFolder.value || undefined
    })
    if (picked) destination.value = picked
  } catch (error) {
    notifications.pushError(`Could not choose an export folder: ${String(error)}`)
  }
}
onMounted(() => card.value?.focus())

async function submit(): Promise<void> {
  const parsed = settings.value
  if (submitting.value || !parsed.success || !hasClips.value) return
  submitting.value = true
  try {
    let path = project.currentFilePath
    if (!path) {
      path = await window.silverdaw.chooseProjectSaveAs(project.projectName || 'Untitled')
      if (!path) return
    }
    project.setExportSettingsJson(mergeExportSettings(project.exportSettingsJson, {
      trackExport: {
        format: parsed.data.format,
        bitDepth: parsed.data.bitDepth,
        bitrateKbps: parsed.data.bitrateKbps,
        outputFolder: parsed.data.outputFolder,
        // A header export is a one-off; keep the File menu's batch selection.
        trackIds: props.initialTrackId ? preferences.trackIds
          : selection.value === null ? null : Object.keys(parsed.data.trackLabels)
      }
    }))
    if (!project.currentFilePath) {
      const saved = await project.saveAndWait(path, true)
      if (!saved.ok) {
        notifications.pushError(`Track export could not start: ${saved.error ?? 'Project was not saved.'}`)
        return
      }
    } else {
      // Flush preferences now without saving any arrangement edits the user may later discard.
      const saved = await project.saveViewStateAndWait()
      if (!saved.ok) {
        notifications.pushError(`Could not remember track export settings: ${saved.error ?? 'Project file could not be updated.'}`)
      }
    }
    if (!send('TRACK_EXPORT_START', parsed.data)) {
      notifications.pushError('Track export could not start: the audio engine is not connected.')
      return
    }
    beginTrackExport(parsed.data.outputFolder ?? exportFolder(path), parsed.data.format)
    emit('close')
  } catch (error) {
    notifications.pushError(`Track export could not start: ${String(error)}`)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-tracks-title"
      @keydown.esc.prevent="!submitting && emit('close')"
    >
      <div
        ref="card"
        class="dialog-card w-[min(640px,92vw)] outline-none"
        tabindex="-1"
      >
        <div class="dialog-header">
          <h1
            id="export-tracks-title"
            class="dialog-title"
          >
            Export Tracks
          </h1>
        </div>
        <div class="dialog-body space-y-3">
          <p
            v-if="!hasClips"
            class="text-amber-300"
          >
            Nothing to export. Add a clip to the timeline first.
          </p>
          <p>Export one stereo file per selected track, from 0:00 to the end of the arrangement. Mute, solo and master effects are ignored.</p>
          <ExportTrackPicker
            v-model="selectedIds"
            :tracks="project.tracks"
          />
          <ExportFormatSettings
            v-model:format="format"
            v-model:sample-rate="sampleRate"
            v-model:bit-depth="bitDepth"
            v-model:bitrate="bitrate"
            :available-bit-depths="availableBitDepths"
          >
            <div>
              <label
                for="track-export-tail"
                class="mb-1 block whitespace-nowrap text-[11px] uppercase tracking-wide text-zinc-500"
              >Tail (seconds)</label>
              <div class="flex items-center rounded border border-zinc-700 bg-zinc-950 pr-1 focus-within:border-sky-500">
                <input
                  id="track-export-tail"
                  ref="tailInput"
                  v-model.number="tailSeconds"
                  type="number"
                  min="0"
                  max="60"
                  step="1"
                  :aria-invalid="invalidTail"
                  :aria-describedby="invalidTail ? 'track-export-tail-error' : undefined"
                  class="no-spinner h-6 min-w-0 flex-1 bg-transparent px-2 py-0 text-right font-mono text-xs leading-6 tabular-nums outline-none"
                >
                <div class="flex flex-col">
                  <button
                    v-for="delta in [1, -1]"
                    :key="delta"
                    type="button"
                    tabindex="-1"
                    data-borderless-button="true"
                    :aria-label="delta > 0 ? 'Increase tail' : 'Decrease tail'"
                    class="flex h-3 w-4 items-center justify-center text-zinc-500 hover:text-zinc-100"
                    @mousedown.prevent
                    @click="stepTail(delta)"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      class="h-3 w-4"
                      :class="{ 'rotate-180': delta < 0 }"
                      aria-hidden="true"
                    >
                      <path d="M5 15l7-7 7 7z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </ExportFormatSettings>
          <p
            v-if="invalidTail"
            id="track-export-tail-error"
            class="text-xs text-red-400"
          >
            Enter a whole number of tail seconds between 0 and 60.
          </p>
          <label class="flex items-center gap-2">
            <input
              v-model="includeEffects"
              type="checkbox"
              class="accent-sky-500"
            >
            Include track effects
          </label>
          <ExportOutputLocation
            v-model:output-path="destination"
            label="Output folder"
            :placeholder="defaultFolder || 'Project export folder (after saving)'"
            :on-browse-click="browse"
          />
          <p
            v-if="!settings.success && settings.error.issues.some(issue => issue.path[0] === 'outputFolder')"
            class="text-xs text-red-400"
          >
            Choose a folder or enter its full path.
          </p>
        </div>
        <div class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            :disabled="submitting"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            type="button"
            class="dialog-btn-primary"
            :disabled="submitting || !hasClips || !settings.success"
            @click="submit"
          >
            {{ project.currentFilePath ? 'Export' : 'Save and Export…' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.no-spinner {
  appearance: textfield;
}
.no-spinner::-webkit-inner-spin-button,
.no-spinner::-webkit-outer-spin-button {
  appearance: none;
  margin: 0;
}
</style>
