import { computed, watch, type Ref } from 'vue'
import { exportBitDepths, type ExportBitDepth, type ExportFormat } from '@shared/bridge-protocol'

export function useExportBitDepths(format: Ref<ExportFormat>, depth: Ref<ExportBitDepth>) {
  const allowed = computed(() => exportBitDepths(format.value))
  watch(allowed, depths => {
    const highest = depths.at(-1)
    if (highest !== undefined && !depths.includes(depth.value)) depth.value = highest
  }, { immediate: true })
  return allowed
}
