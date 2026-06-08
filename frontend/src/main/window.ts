// Creates the hardened main BrowserWindow: context isolation + sandbox, denied
// window-open, blocked reload/navigation, mixed-DPI bounds, and persisted window
// state wiring. Registered from main/index.ts, which owns the window reference.

import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../shared/ipc-channels'
import { logMain } from './log'
import type { PrefsService } from './prefsService'

// Kept in sync with the renderer Tailwind palette (zinc-900).
const COLOUR_BG = '#18181b'

export interface CreateWindowContext {
  prefs: PrefsService
  startupDevToolsEnabled: boolean
  isCloseConfirmed(): boolean
}

export function createWindow(ctx: CreateWindowContext): BrowserWindow {
  const { prefs } = ctx
  const bounds = prefs.resolveWindowBounds()
  // Icon is optional; Electron falls back cleanly.
  const iconPath = join(app.getAppPath(), 'resources', 'icons', 'icon.ico')
  const icon = existsSync(iconPath) ? iconPath : undefined
  if (!icon) {
    logMain('INFO ', 'main', `no app icon at ${iconPath} — using Electron default`)
  }
  const win = new BrowserWindow({
    // Set bounds after construction to avoid Windows hidden-titlebar DPI drift.
    minWidth: 900,
    minHeight: 600,
    backgroundColor: COLOUR_BG,
    icon,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: undefined,
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: {
      // Sandboxed renderers require the electron-vite CJS preload bundle.
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      // Sandbox stays on because preload only needs safe Electron bridge APIs.
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  // Block reloads because they orphan backend state; gate packaged DevTools shortcuts.
  const RELOAD_KEYS = new Set(['F5', 'F3'])
  const blockDevTools = app.isPackaged && !ctx.startupDevToolsEnabled
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isReloadKey = RELOAD_KEYS.has(input.key) ||
      (input.control && (input.key === 'r' || input.key === 'R')) ||
      (input.meta && (input.key === 'r' || input.key === 'R'))
    if (isReloadKey) {
      event.preventDefault()
      return
    }
    if (blockDevTools) {
      const isDevToolsKey =
        (input.control && input.shift && (input.key === 'i' || input.key === 'I')) ||
        input.key === 'F12'
      if (isDevToolsKey) {
        event.preventDefault()
      }
    }
  })

  // Block SPA navigation so browser history shortcuts do not steal transport keys.
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  // Deny new windows so untrusted content cannot escape our hardened BrowserWindow.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Auto-open DevTools only in dev when the startup debug gate allows it.
  if (!app.isPackaged && ctx.startupDevToolsEnabled) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.openDevTools({ mode: 'right' })
    })
  }

  // On Windows mixed-DPI setups, a second `setBounds` applies the target display scale.
  if (typeof bounds.x === 'number' && typeof bounds.y === 'number') {
    const rect = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    }
    win.setBounds(rect)
    if (process.platform === 'win32') win.setBounds(rect)
  } else {
    win.setSize(bounds.width, bounds.height)
    win.center()
  }

  // Maximize after applying normal bounds so restore targets the saved size.
  if (prefs.get().window.maximized) win.maximize()

  const capture = (): void => prefs.captureWindowState(win)
  win.on('resize', capture)
  win.on('move', capture)
  win.on('maximize', capture)
  win.on('unmaximize', capture)
  win.on('close', (event) => {
    prefs.captureWindowState(win)
    prefs.flushSaveSync()
    // First close attempt runs the renderer's unsaved-changes guard.
    if (!ctx.isCloseConfirmed()) {
      event.preventDefault()
      win.webContents.send(IPC.menu.action, 'app.requestClose')
    }
  })

  // Avoid showing a blank window before the first renderer paint.
  win.once('ready-to-show', () => {
    win.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }

  return win
}
