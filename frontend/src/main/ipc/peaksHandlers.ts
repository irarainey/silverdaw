// Peaks-cache IPC handler: reads waveform `.peaks` files, confined to the
// backend-produced cache directory. Registered from main/index.ts.

import { app, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { resolve as pathResolve } from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import { logMain } from '../log'

export function registerPeaksHandlers(): void {
  // Peaks reads are confined to the backend-produced cache directory.
  const peaksCacheDir = pathResolve(app.getPath('appData'), 'Silverdaw', 'peaks')
  ipcMain.handle(IPC.peaks.readCacheFile, async (_evt, value: unknown): Promise<ArrayBuffer | null> => {
    if (typeof value !== 'string' || value.length === 0) return null
    const canonical = pathResolve(value)
    if (!canonical.toLowerCase().startsWith(peaksCacheDir.toLowerCase() + '\\') &&
        canonical.toLowerCase() !== peaksCacheDir.toLowerCase()) {
      logMain('WARN ', 'peaks:readCacheFile', 'refused path outside cache dir:', canonical)
      return null
    }
    try {
      const buf = await readFile(canonical)
      // Structured clone should receive a clean contiguous buffer.
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    } catch (err) {
      logMain('WARN ', 'peaks:readCacheFile', `read failed for ${canonical}:`, err)
      return null
    }
  })
}
