// App runtime IPC handlers: renderer log batching, bridge port/token, backend
// watchdog restart, app/version info, and guarded external-link opening.
// Registered from main/index.ts.

import { app, ipcMain, shell } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { sendDiagnosticLogs } from '../diagnostics'
import { logRendererLine, type LogLevel } from '../log'

export interface RuntimeHandlersContext {
  getBridgePort(): number
  getBridgeToken(): string
  requestBackendRestart(reason: string): void
}

export function registerRuntimeHandlers(ctx: RuntimeHandlersContext): void {
  // Renderer logs are batched into the same session folder as main/backend logs.
  ipcMain.handle(
    IPC.log.appendBatch,
    (_evt, entries: Array<{ level: LogLevel; tag: string; message: string; timestamp: number }>) => {
      if (!Array.isArray(entries)) return
      for (const e of entries) {
        if (!e || typeof e.tag !== 'string' || typeof e.message !== 'string') continue
        logRendererLine(e.level ?? 'INFO ', e.tag, e.message, e.timestamp)
      }
    }
  )

  // Main-selected dynamic backend port.
  ipcMain.handle(IPC.bridge.getPort, () => ctx.getBridgePort())

  // AUTH token only crosses the trusted preload bridge.
  ipcMain.handle(IPC.bridge.getToken, () => ctx.getBridgeToken())

  // Watchdog restart keeps the same port/token for reconnect.
  ipcMain.handle(IPC.backend.restart, (_evt, reason: unknown) => {
    ctx.requestBackendRestart(typeof reason === 'string' ? reason : 'renderer request')
  })

  ipcMain.handle(IPC.app.getInfo, () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node
  }))

  // Only http/https links (browser) and mailto: drafts (default mail client) may leave
  // the app; everything else is refused so the renderer can't launch arbitrary handlers.
  ipcMain.on(IPC.app.openExternal, (_evt, url: unknown) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'mailto:') return
    void shell.openExternal(parsed.toString())
  })

  // Zip the current run's logs, reveal the bundle, and open a support email draft.
  // Runs in main (filesystem + shell); the renderer awaits it to show a wait spinner.
  ipcMain.handle(IPC.app.sendDiagnostics, () => sendDiagnosticLogs())
}
