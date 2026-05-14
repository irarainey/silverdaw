// Preload script — runs in an isolated context with access to Node APIs.
// Expose only what the renderer needs via `contextBridge`.
import { contextBridge } from 'electron'

const api = {
  appName: 'Jackdaw',
  version: '0.1.0'
} as const

contextBridge.exposeInMainWorld('jackdaw', api)

export type JackdawApi = typeof api
