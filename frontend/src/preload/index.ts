// Preload script - runs in an isolated context with access to Node APIs.
// Expose only what the renderer needs via `contextBridge`.
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  appName: 'Jackdaw',
  version: '0.1.0',
  platform: process.platform,
  /** Send a menu action ID to the main process. */
  menuAction: (action: string): void => {
    ipcRenderer.send('menu:action', action)
  }
} as const

contextBridge.exposeInMainWorld('jackdaw', api)

export type JackdawApi = typeof api
