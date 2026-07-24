import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'
import { useProjectImportState } from '@/lib/projectImportState'

export const projectImportBridgeHandlers: BridgeInboundHandlers<
  | 'PROJECT_IMPORT_SOURCE_MANIFEST'
  | 'PROJECT_IMPORT_SOURCE_FAILED'
  | 'PROJECT_IMPORT_COMPLETED'
> = {
  PROJECT_IMPORT_SOURCE_MANIFEST: (payload) => useProjectImportState().applyManifest(payload),
  PROJECT_IMPORT_SOURCE_FAILED: (payload) => useProjectImportState().applyFailure(payload),
  PROJECT_IMPORT_COMPLETED: (payload) => useProjectImportState().applyCompleted(payload)
}
