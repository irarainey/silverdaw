import { readonly, ref } from 'vue'
import { send as sendBridge } from '@/lib/bridgeService'
import type {
  ProjectImportResultPayload,
  ProjectImportSourceManifestPayload
} from '@shared/bridge-protocol'

const manifest = ref<ProjectImportSourceManifestPayload | null>(null)
const inspecting = ref(false)
const importing = ref(false)
const error = ref<string | null>(null)
const completed = ref(false)
const activeSourceProjectPath = ref('')

export function useProjectImportState() {
  function inspect(sourceProjectPath: string): void {
    activeSourceProjectPath.value = sourceProjectPath
    manifest.value = null
    error.value = null
    completed.value = false
    inspecting.value = sendBridge('PROJECT_IMPORT_SOURCE_INSPECT', { sourceProjectPath })
  }

  function importAssets(
    sourceProjectPath: string,
    libraryItemIds: string[]
  ): void {
    activeSourceProjectPath.value = sourceProjectPath
    error.value = null
    completed.value = false
    importing.value = sendBridge('PROJECT_IMPORT_ASSETS', {
      sourceProjectPath,
      libraryItemIds
    })
  }

  function applyManifest(payload: ProjectImportSourceManifestPayload): void {
    if (payload.sourceProjectPath !== activeSourceProjectPath.value) return
    manifest.value = payload
    inspecting.value = false
    error.value = null
  }

  function applyFailure(payload: ProjectImportResultPayload): void {
    if (payload.sourceProjectPath !== activeSourceProjectPath.value) return
    inspecting.value = false
    importing.value = false
    error.value = payload.error ?? 'Could not inspect the selected project.'
  }

  function applyCompleted(payload: ProjectImportResultPayload): void {
    if (payload.sourceProjectPath !== activeSourceProjectPath.value) return
    importing.value = false
    if (payload.ok) {
      completed.value = true
      error.value = null
      return
    }
    error.value = payload.error ?? 'Could not import the selected assets.'
  }

  function reset(): void {
    activeSourceProjectPath.value = ''
    manifest.value = null
    inspecting.value = false
    importing.value = false
    error.value = null
    completed.value = false
  }

  return {
    manifest: readonly(manifest),
    inspecting: readonly(inspecting),
    importing: readonly(importing),
    error: readonly(error),
    completed: readonly(completed),
    inspect,
    importAssets,
    applyManifest,
    applyFailure,
    applyCompleted,
    reset
  }
}
