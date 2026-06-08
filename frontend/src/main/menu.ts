// Native menu action router. Most actions forward to the renderer; a few are
// handled in main (confirmed close, DevTools/full-screen, external links).
// Registered from main/index.ts via the IPC.menu.action channel.

import { app, BrowserWindow, shell, type BrowserWindow as BrowserWindowType } from 'electron'
import { IPC } from '../shared/ipc-channels'

export interface MenuActionContext {
  getMainWindow(): BrowserWindowType | null
  startupDevToolsEnabled: boolean
  confirmClose(): void
}

export function handleMenuAction(action: string, ctx: MenuActionContext): void {
  const mainWindow = ctx.getMainWindow()
  if (!mainWindow) return
  const wc = mainWindow.webContents

  switch (action) {
    // File
    case 'file.newProject':
      wc.send(IPC.menu.action, action)
      break
    case 'file.openProject':
      wc.send(IPC.menu.action, action)
      break
    case 'file.save':
      wc.send(IPC.menu.action, action)
      break
    case 'file.saveAs':
      wc.send(IPC.menu.action, action)
      break
    case 'file.renameProject':
      wc.send(IPC.menu.action, action)
      break
    case 'file.projectProperties':
      wc.send(IPC.menu.action, action)
      break
    case 'file.addTrack':
      wc.send(IPC.menu.action, action)
      break
    case 'file.exportMixdown':
      wc.send(IPC.menu.action, action)
      break
    case 'file.exit':
      wc.send(IPC.menu.action, action)
      break
    case 'file.exitConfirmed':
    case 'app.confirmClose':
      // Renderer has cleared the unsaved-changes guard.
      ctx.confirmClose()
      break

    // Edit
    case 'edit.undo':
      // Renderer handles project undo; native text undo stays on keyboard shortcuts.
      wc.send(IPC.menu.action, action)
      break
    case 'edit.redo':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.cut':
      // Renderer can target clips before falling back to native text cut.
      wc.send(IPC.menu.action, action)
      break
    case 'edit.copy':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.paste':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.preferences':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.splitAtPlayhead':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.duplicateClip':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.deleteClip':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.cropProjectToLastClip':
      wc.send(IPC.menu.action, action)
      break

    // View
    case 'view.zoomIn':
    case 'view.zoomOut':
    case 'view.zoomReset':
      wc.send(IPC.menu.action, action)
      break
    case 'view.toggleDevTools':
      if (app.isPackaged && !ctx.startupDevToolsEnabled) break
      wc.toggleDevTools()
      break
    case 'view.toggleFullScreen':
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
      break

    // Help
    case 'help.docs':
      void shell.openExternal('https://github.com/irarainey/silverdaw')
      break
    case 'help.reportIssue':
      void shell.openExternal('https://github.com/irarainey/silverdaw/issues/new')
      break
    case 'help.about':
      wc.send(IPC.menu.action, action)
      break

    default:
      if (action.startsWith('file.openRecentByIndex:')) {
        wc.send(IPC.menu.action, action)
        break
      }
      if (action === 'file.clearRecentProjects') {
        wc.send(IPC.menu.action, action)
        break
      }
      if (action.startsWith('view.zoomPreset:')) {
        wc.send(IPC.menu.action, action)
        break
      }
      console.warn('[menu] unknown action:', action)
  }
}

/** Destroy all windows and exit after the renderer clears its unsaved-changes guard. */
export function destroyAllWindowsAndExit(): void {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) w.destroy()
  })
  app.exit(0)
}
