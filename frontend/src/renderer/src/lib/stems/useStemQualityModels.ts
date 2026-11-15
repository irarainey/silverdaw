import { computed, ref } from 'vue'
import { log } from '@/lib/log'
import { MODEL_SOURCES } from './stemModelSources'
import {
  startDownloadRun,
  type DownloadRunHandle,
  type DownloadSource
} from './stemModelDownloadRunner'
import type { EnsureStemModelResult } from '@shared/types'

// Downloads belong to the renderer session, not a mounted Preferences tab.
const vocalInstalled = ref(false)
const rhythmInstalled = ref(false)
const qualityBusy = ref(false)
const qualityPercent = ref(0)
const qualityError = ref<string | null>(null)
const qualityInstalled = computed(() => vocalInstalled.value && rhythmInstalled.value)
const qualityPartlyInstalled = computed(
  () => (vocalInstalled.value || rhythmInstalled.value) && !qualityInstalled.value
)
let activeDownload: DownloadRunHandle | null = null
let cancelRequested = false
let refreshId = 0

async function refreshQuality(): Promise<void> {
  const id = ++refreshId
  try {
    const [vocal, rhythm] = await Promise.all([
      MODEL_SOURCES.vocalPack.getState(),
      MODEL_SOURCES.rhythmPack.getState()
    ])
    if (id !== refreshId) return
    vocalInstalled.value = vocal.installed
    rhythmInstalled.value = rhythm.installed
  } catch (error) {
    log.warn('stems', `Could not check quality models: ${String(error)}`)
    if (id === refreshId) qualityError.value = 'Could not check installed separation models.'
  }
}

async function downloadQualityModels(): Promise<void> {
  if (qualityBusy.value) return
  qualityBusy.value = true
  qualityError.value = null
  qualityPercent.value = 0
  cancelRequested = false
  const pending: Promise<EnsureStemModelResult>[] = []
  try {
    const sources = [MODEL_SOURCES.vocalPack, MODEL_SOURCES.rhythmPack]
    const states = await Promise.all(sources.map((source) => source.getState()))
    if (cancelRequested) return
    const total = Math.max(
      1,
      states.reduce((sum, state) => sum + state.totalBytes, 0)
    )
    const installedBytes = states.reduce(
      (sum, state) => sum + (state.installed ? state.totalBytes : 0),
      0
    )
    qualityPercent.value = Math.min(
      100,
      Math.round((states.reduce((sum, state) => sum + state.presentBytes, 0) / total) * 100)
    )
    const downloads: DownloadSource[] = sources.flatMap((source, index) => {
      const state = states[index]
      if (!state || state.installed) return []
      return [
        {
          totalBytes: state.totalBytes,
          presentBytes: state.presentBytes,
          ensure: () => {
            const task = source.ensure()
            pending.push(task)
            return task
          },
          onProgress: (handler) => source.onProgress(handler),
          cancel: () => source.cancel()
        }
      ]
    })
    const { handle, done } = startDownloadRun(
      downloads,
      (progress) => {
        qualityPercent.value = Math.min(
          100,
          Math.round(((installedBytes + progress.receivedBytes) / total) * 100)
        )
      },
      1
    )
    activeDownload = handle
    const result = await done
    if (result.outcome === 'error') {
      qualityError.value = result.error
      log.warn('stems', `Quality model download failed: ${result.error}`)
    } else if (result.outcome === 'success') {
      qualityPercent.value = 100
    }
  } catch (error) {
    qualityError.value = error instanceof Error ? error.message : String(error)
    log.warn('stems', `Quality model download failed: ${qualityError.value}`)
  } finally {
    // Keep ownership until main acknowledges cancellation, so a retry cannot race it.
    await Promise.allSettled(pending)
    activeDownload = null
    await refreshQuality()
    qualityBusy.value = false
  }
}

function cancelQualityDownload(): void {
  cancelRequested = true
  activeDownload?.cancel()
}

export function useStemQualityModels() {
  return {
    vocalInstalled,
    rhythmInstalled,
    qualityBusy,
    qualityPercent,
    qualityError,
    qualityInstalled,
    qualityPartlyInstalled,
    refreshQuality,
    downloadQualityModels,
    cancelQualityDownload
  }
}
