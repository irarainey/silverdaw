// Plugin-domain inbound handlers: the scanned VST3 catalogue, scan progress, and the
// user-facing notices a chain edit can raise (ADR 0025).

import { useProjectStore } from '@/stores/projectStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const pluginBridgeHandlers: BridgeInboundHandlers<
  'PLUGIN_LIST' | 'PLUGIN_SCAN_PROGRESS' | 'PLUGIN_NOTICE'
> = {
  PLUGIN_LIST: (payload) => {
    const project = useProjectStore()
    // Instruments cannot be used as an insert, so they never reach the picker.
    project.pluginCatalogue = payload.plugins.filter((entry) => entry.isInstrument !== true)
    project.pluginScanning = payload.scanning === true
    if (!project.pluginScanning) project.pluginScanStatus = null
  },

  PLUGIN_SCAN_PROGRESS: (payload) => {
    const project = useProjectStore()
    if (payload.finished === true) {
      project.pluginScanning = false
      project.pluginScanStatus = null
      return
    }
    project.pluginScanning = true
    project.pluginScanStatus =
      payload.total > 0
        ? `Scanning ${payload.scanned} of ${payload.total}…`
        : 'Scanning plugins…'
  },

  PLUGIN_NOTICE: (payload) => {
    // Already written for the user by the backend, so it is shown as-is.
    useNotificationsStore().push(payload.severity, payload.message, 10000)
  }
}
