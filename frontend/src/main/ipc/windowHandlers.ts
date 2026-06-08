// Window-chrome IPC handlers: minimize, toggle maximize, and request close.
// Registered from main/index.ts.

import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'

export interface WindowHandlersContext {
  getMainWindow(): BrowserWindow | null
}

export function registerWindowHandlers(ctx: WindowHandlersContext): void {
  ipcMain.on(IPC.window.minimize, () => {
    ctx.getMainWindow()?.minimize()
  })

  ipcMain.on(IPC.window.toggleMaximize, () => {
    const win = ctx.getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on(IPC.window.close, () => {
    ctx.getMainWindow()?.webContents.send(IPC.menu.action, 'app.requestClose')
  })
}
