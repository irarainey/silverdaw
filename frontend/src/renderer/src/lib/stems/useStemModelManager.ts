// Live (non-transactional) state for the Preferences "Stems" tab: GPU
// availability, the on-disk model location/status, an inline first-use download
// with progress, and the "locate an existing copy" flow. Mirrors how the audio
// tab drives live device actions rather than the dialog's deferred Save model —
// downloading or locating a ~1.2 GB model has an immediate side effect.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { StemGpuStatus, StemModelInfo } from '@shared/types'

export interface StemModelManager {
  gpu: Ref<StemGpuStatus>
  modelInfo: Ref<StemModelInfo | null>
  busy: Ref<boolean>
  downloadPercent: Ref<number | null>
  error: Ref<string | null>
  installed: ComputedRef<boolean>
  refresh: () => Promise<void>
  download: () => Promise<void>
  cancelDownload: () => void
  locate: () => Promise<void>
}

export function useStemModelManager(): StemModelManager {
  const gpu = ref<StemGpuStatus>({ available: false, name: null })
  const modelInfo = ref<StemModelInfo | null>(null)
  const busy = ref(false)
  const downloadPercent = ref<number | null>(null)
  const error = ref<string | null>(null)

  const installed = computed(() => modelInfo.value?.installed === true)

  async function refresh(): Promise<void> {
    try {
      const [gpuStatus, info] = await Promise.all([
        window.silverdaw.getStemGpuStatus(),
        window.silverdaw.getStemModelInfo()
      ])
      gpu.value = gpuStatus
      modelInfo.value = info
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function download(): Promise<void> {
    if (busy.value) return
    error.value = null
    busy.value = true
    downloadPercent.value = 0
    const off = window.silverdaw.onStemModelDownloadProgress((p) => {
      downloadPercent.value =
        p.totalBytes > 0 ? Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100)) : 0
    })
    try {
      const result = await window.silverdaw.ensureStemModel()
      if (!result.ok) error.value = result.error
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      off()
      busy.value = false
      downloadPercent.value = null
      await refresh()
    }
  }

  function cancelDownload(): void {
    window.silverdaw.cancelStemModelDownload()
  }

  async function locate(): Promise<void> {
    if (busy.value) return
    error.value = null
    const dir = await window.silverdaw.chooseDirectory({
      title: 'Locate stem-separation model folder',
      defaultPath: modelInfo.value?.directory || undefined
    })
    if (!dir) return
    busy.value = true
    try {
      const result = await window.silverdaw.locateStemModel(dir)
      if (!result.ok) error.value = result.error
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      busy.value = false
      await refresh()
    }
  }

  return {
    gpu,
    modelInfo,
    busy,
    downloadPercent,
    error,
    installed,
    refresh,
    download,
    cancelDownload,
    locate
  }
}
