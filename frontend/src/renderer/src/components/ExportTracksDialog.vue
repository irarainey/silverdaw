<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { TrackExportStartSchema } from '@shared/bridge-protocol'
import { send } from '@/lib/bridgeService'
import { exportSampleRate } from '@/lib/export/exportSampleRate'
import { beginTrackExport } from '@/lib/mixdownState'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'

const emit = defineEmits<{ close: [] }>()
const project = useProjectStore()
const notifications = useNotificationsStore()
const sampleRate = ref(exportSampleRate(project.targetSampleRate, useUiStore().defaultProjectSampleRate))
const bitDepth = ref(24)
const includeEffects = ref(true)
const tailSeconds = ref(0)
const submitting = ref(false)
const card = ref<HTMLElement | null>(null)
const hasClips = computed(() => project.tracks.some(track => track.clipIds.length > 0))
const settings = computed(() => TrackExportStartSchema.safeParse({
  sampleRate: sampleRate.value, bitDepth: bitDepth.value,
  includeEffects: includeEffects.value, tailSeconds: tailSeconds.value,
  trackLabels: Object.fromEntries(project.tracks.map(track => [track.id, track.name]))
}))
function exportFolder(path: string): string {
  return path.replace(/[^\\/]+$/, 'export')
}
const destination = computed(() => project.currentFilePath && exportFolder(project.currentFilePath))
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
      const saved = await project.saveAndWait(path, true)
      if (!saved.ok) {
        notifications.pushError(`Track export could not start: ${saved.error ?? 'Project was not saved.'}`)
        return
      }
    }
    if (!send('TRACK_EXPORT_START', parsed.data)) {
      notifications.pushError('Track export could not start: the audio engine is not connected.')
      return
    }
    beginTrackExport(exportFolder(path))
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
        class="dialog-card w-[min(460px,90vw)] outline-none"
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
          <p>Export every track as a stereo WAV from 0:00 to the same end time. Mute, solo and master effects are ignored.</p>
          <div class="flex gap-3">
            <label>Sample rate
              <select
                v-model.number="sampleRate"
                class="app-select w-full"
              >
                <option :value="44100">44.1 kHz</option>
                <option :value="48000">48 kHz</option>
              </select>
            </label>
            <label>Bit depth
              <select
                v-model.number="bitDepth"
                class="app-select w-full"
              >
                <option :value="16">16-bit</option>
                <option :value="24">24-bit</option>
                <option :value="32">32-bit float</option>
              </select>
            </label>
            <label>Tail (seconds)
              <input
                v-model.number="tailSeconds"
                type="number"
                min="0"
                max="60"
                step="any"
                class="no-spinner block w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-xs tabular-nums outline-none focus:border-sky-500"
              >
            </label>
          </div>
          <label class="flex items-center gap-2">
            <input
              v-model="includeEffects"
              type="checkbox"
              class="accent-sky-500"
            >
            Include track effects
          </label>
          <p class="break-words text-xs text-zinc-400">
            {{ destination ? `Destination: ${destination}` : 'Save your project first to export to its export folder.' }}
            Each export creates a new numbered folder.
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
