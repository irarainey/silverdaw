<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { buildSampleReport } from '@/lib/project/sampleReport'
import { projectRootFromPath, reportFilePath } from '@/lib/project/projectPath'
import { formatTrackTimestamp as time } from '@/lib/library/trackTime'
import { useProjectStore } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'

const emit = defineEmits<{ close: [] }>()
const project = useProjectStore()
const library = useLibraryStore()
const notifications = useNotificationsStore()
const projectRoot = computed(() => projectRootFromPath(project.currentFilePath))
const sources = computed(() => buildSampleReport(project.tracks, project.clips, library.byId, projectRoot.value))
const busy = ref(false)
const card = ref<HTMLElement | null>(null)
onMounted(() => card.value?.focus())

async function exportPdf(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    let path = project.currentFilePath
    if (!path) {
      path = await window.silverdaw.chooseProjectSaveAs(project.projectName)
      if (!path) return
      const saved = await project.saveAndWait(path, true)
      if (!saved.ok) {
        notifications.pushError(`Report not exported: ${saved.error ?? 'Project was not saved.'}`)
        return
      }
      await nextTick()
    }
    const destination = await window.silverdaw.exportSampleReport(path)
    if (!destination) return
    notifications.pushInfo(`Audio Sample Report saved to ${destination}`)
    emit('close')
  } catch (error) {
    log.warn('sampleReport', `PDF export failed: ${String(error)}`)
    notifications.pushError('Could not save the PDF. Choose a writable folder and a .pdf filename, then try again.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      id="sample-report"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sample-report-title"
      @keydown.esc.stop="!busy && emit('close')"
    >
      <div
        ref="card"
        tabindex="-1"
        class="dialog-card w-[min(1440px,98vw)]"
      >
        <header class="dialog-header">
          <h1
            id="sample-report-title"
            class="dialog-title"
          >
            Audio Sample Report
          </h1>
        </header>
        <div class="dialog-body silverdaw-scroll space-y-3 break-words text-xs">
          <div class="space-y-1">
            <h2><strong>Project name:</strong> {{ project.projectName }}</h2>
            <p><strong>Location:</strong> {{ projectRoot || 'Project not yet saved' }}</p>
          </div>
          <p v-if="!sources.length">
            No clips are placed on the timeline.
          </p>
          <section
            v-for="source in sources"
            :key="source.key"
            class="space-y-1 border-t border-zinc-800 pt-3"
          >
            <h3>
              <strong>Track:</strong> {{ source.title }}
            </h3>
            <p><strong>Artist:</strong> {{ source.artist }}</p>
            <p><strong>Album:</strong> {{ source.album }}</p>
            <p>
              <strong>Source file:</strong> {{ reportFilePath(source.path, projectRoot) || 'Cannot be determined' }}
              <span v-if="source.pathMatch">(matched by {{ source.pathMatch }})</span>
            </p>
            <p v-if="source.hasSeparatedStems">
              <strong>Provenance:</strong> Includes separated stems.
            </p>
            <p>
              <strong>Placements:</strong> {{ source.usage.placements }} ·
              <strong>Stems:</strong> {{ source.usage.stems }} · <strong>Known distinct passages:</strong> {{ source.usage.passages }}
              <span v-if="source.usage.knownOriginalMs !== undefined"> ({{ time(source.usage.knownOriginalMs) }} of the original)</span>
              <span v-if="source.usage.windowOnly"> · Placements with source window only: {{ source.usage.windowOnly }}</span>
              <span v-if="source.usage.unmapped"> · Placements with unknown original range: {{ source.usage.unmapped }}</span>
            </p>
            <p>
              <strong>Timeline coverage:</strong> {{ time(source.usage.arrangedMs) }} arranged
              <span v-if="source.usage.excluded">
                · {{ time(source.usage.includedMs) }} after mute/solo ({{ source.usage.excluded }} excluded)
              </span>
            </p>
            <table class="w-full text-left text-[11px]">
              <thead>
                <tr><th>Project track</th><th>Clip</th><th>File type</th><th>Timeline range</th><th>Duration</th><th>File range</th><th>Original recording range</th></tr>
              </thead>
              <tbody
                v-for="file in source.files"
                :key="file.path"
              >
                <tr v-if="file.path === source.path && source.files.length > 1">
                  <td colspan="7">
                    <strong>Original file</strong>
                  </td>
                </tr>
                <tr
                  v-for="use in file.placements"
                  :key="use.id"
                >
                  <td>{{ use.track }}<span v-if="use.excluded"> ({{ use.excluded }})</span></td><td>{{ use.name }}</td>
                  <td>{{ use.fileType }}<span v-if="use.stemRole"> ({{ use.stemRole }})</span></td>
                  <td>{{ time(use.startMs) }} – {{ time(use.endMs) }}</td>
                  <td>{{ time(use.durationMs) }}</td>
                  <td>{{ time(use.sourceStartMs) }} – {{ time(use.sourceEndMs) }}</td>
                  <td>
                    <template v-if="use.originalRange">
                      {{ time(use.originalRange.startMs) }} – {{ time(use.originalRange.endMs) }}
                    </template>
                    <template v-else-if="use.originalWindow">
                      Within {{ time(use.originalWindow.startMs) }} – {{ time(use.originalWindow.endMs) }} (source window only)
                    </template>
                    <template v-else>
                      Cannot be determined
                    </template>
                  </td>
                </tr>
                <tr v-if="file.path !== source.path">
                  <td colspan="7">
                    <p class="pl-4 text-[10px] text-zinc-400 print:text-zinc-600">
                      <strong>Derived file:</strong> {{ reportFilePath(file.path, projectRoot) }}
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
        <footer class="dialog-footer">
          <button
            class="dialog-btn-cancel"
            :disabled="busy"
            @click="emit('close')"
          >
            Close
          </button>
          <button
            class="dialog-btn-primary"
            :disabled="busy"
            @click="exportPdf"
          >
            {{ busy ? 'Exporting' : project.currentFilePath ? 'Export PDF' : 'Save and Export PDF' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
th, td { padding: 0.25rem; overflow-wrap: anywhere; }
td:nth-child(n+4) { font-family: monospace; }
@media print {
  :global(html), :global(body) { height: auto; overflow: visible; background: white; }
  :global(body > :not(#sample-report)) { display: none; }
  #sample-report, .dialog-card, .dialog-body, .dialog-header {
    display: block; position: static; width: auto; height: auto; max-height: none;
    overflow: visible; padding: 0; background: white; color: black;
    box-shadow: none; backdrop-filter: none;
  }
  .dialog-title { color: black; }
  .dialog-footer { display: none; }
  tr { break-inside: avoid; }
  h3, thead { break-after: avoid; }
}
</style>
