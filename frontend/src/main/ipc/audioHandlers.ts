// Audio IPC handlers: file open/import dialogs, allow-listed reads, metadata,
// and the renderer-PCM -> float-WAV transcode cache. Registered from main/index.ts.

import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { parseFile } from 'music-metadata'
import { IPC } from '../../shared/ipc-channels'
import { normalizeMetadata } from '../audioMetadata'
import {
  AUDIO_FILE_EXTENSIONS,
  canonicalisePath,
  isAllowedAudioPath,
  registerIssuedPath
} from '../audioPaths'
import { logMain } from '../log'

/** Singletons the audio handlers reach back into main for. */
export interface AudioHandlersContext {
  getMainWindow(): BrowserWindow | null
  getCurrentClipDir(): string
  setCurrentClipDir(dir: string): void
}

// Cache renderer-side transcodes by source path and decoded geometry.
const TRANSCODE_CACHE_DIR = join(tmpdir(), 'silverdaw-transcode-cache')

export function registerAudioHandlers(ctx: AudioHandlersContext): void {
  function rememberClipDir(pickedFile: string): void {
    if (!pickedFile) return
    const dir = dirname(pickedFile)
    if (dir && dir !== ctx.getCurrentClipDir()) ctx.setCurrentClipDir(dir)
  }

  ipcMain.handle(IPC.audio.open, async () => {
    const win = ctx.getMainWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Add Track from File',
      defaultPath: ctx.getCurrentClipDir() || undefined,
      filters: [{ name: 'Audio files', extensions: [...AUDIO_FILE_EXTENSIONS] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    rememberClipDir(filePath)
    const buf = await readFile(filePath)
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    registerIssuedPath(filePath)
    return { filePath, fileName: basename(filePath), data }
  })

  ipcMain.handle(IPC.audio.openMany, async () => {
    const win = ctx.getMainWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Audio into Library',
      defaultPath: ctx.getCurrentClipDir() || undefined,
      filters: [{ name: 'Audio files', extensions: [...AUDIO_FILE_EXTENSIONS] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    rememberClipDir(result.filePaths[0])
    const out: { filePath: string; fileName: string; data: ArrayBuffer }[] = []
    for (const filePath of result.filePaths) {
      try {
        const buf = await readFile(filePath)
        const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        registerIssuedPath(filePath)
        out.push({ filePath, fileName: basename(filePath), data })
      } catch (err) {
        logMain('ERROR', 'audio:openMany', `read failed for ${filePath}:`, err)
      }
    }
    return out
  })

  // Relink returns a path only; backend reloads audio while metadata reads stay allowed.
  ipcMain.handle(
    IPC.audio.chooseFile,
    async (_evt, args: unknown): Promise<string | null> => {
      const win = ctx.getMainWindow()
      if (!win) return null
      const a = (args ?? {}) as { title?: string; defaultPath?: string }
      const result = await dialog.showOpenDialog(win, {
        title: typeof a.title === 'string' ? a.title : 'Locate audio file',
        defaultPath:
          typeof a.defaultPath === 'string' && a.defaultPath.length > 0
            ? a.defaultPath
            : ctx.getCurrentClipDir() || undefined,
        filters: [{ name: 'Audio files', extensions: [...AUDIO_FILE_EXTENSIONS] }],
        properties: ['openFile']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const picked = result.filePaths[0]
      rememberClipDir(picked)
      registerIssuedPath(picked)
      return picked
    }
  )

  // OS drag-drop paths are registered; actual reads still enforce extension allow-list.
  ipcMain.on(IPC.audio.registerDroppedPath, (_evt, filePath: unknown) => {
    if (typeof filePath !== 'string') return
    registerIssuedPath(filePath)
  })

  ipcMain.handle(IPC.audio.readFile, async (_evt, filePath: unknown) => {
    if (!isAllowedAudioPath(filePath)) {
      logMain('WARN ', 'audio:readFile', 'rejected path not on allow-list:', filePath)
      return null
    }
    try {
      const buf = await readFile(filePath)
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      return { filePath, fileName: basename(filePath), data }
    } catch (err) {
      logMain('ERROR', 'audio:readFile', `failed for ${String(filePath)}:`, err)
      return null
    }
  })

  ipcMain.handle(IPC.audio.readMetadata, async (_evt, filePath: unknown) => {
    if (!isAllowedAudioPath(filePath)) {
      logMain('WARN ', 'audio:readMetadata', 'rejected path not on allow-list:', filePath)
      return null
    }
    try {
      const meta = await parseFile(filePath, { duration: true, skipCovers: false })
      return normalizeMetadata(meta)
    } catch (err) {
      logMain('WARN ', 'audio:readMetadata', `failed for ${String(filePath)}:`, err)
      return null
    }
  })

  // Transcode renderer-decoded PCM for formats the backend cannot decode natively.
  ipcMain.handle(IPC.audio.writeTempWav, async (_evt, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return null
    const p = payload as {
      sourcePath?: unknown
      channels?: unknown
      sampleRate?: unknown
    }
    if (typeof p.sourcePath !== 'string' || !isAllowedAudioPath(p.sourcePath)) {
      logMain('WARN ', 'audio:writeTempWav', 'rejected source not on allow-list:', p.sourcePath)
      return null
    }
    if (typeof p.sampleRate !== 'number' || !Number.isFinite(p.sampleRate) || p.sampleRate <= 0) {
      return null
    }
    if (!Array.isArray(p.channels) || p.channels.length === 0 || p.channels.length > 8) {
      return null
    }
    const chans: Float32Array[] = []
    let frameCount = -1
    for (const c of p.channels) {
      let arr: Float32Array
      if (c instanceof Float32Array) {
        arr = c
      } else if (c instanceof ArrayBuffer) {
        arr = new Float32Array(c)
      } else if (ArrayBuffer.isView(c)) {
        const view = c as ArrayBufferView
        arr = new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4)
      } else {
        return null
      }
      if (frameCount < 0) frameCount = arr.length
      else if (arr.length !== frameCount) return null
      chans.push(arr)
    }
    if (frameCount <= 0) return null

    try {
      await mkdir(TRANSCODE_CACHE_DIR, { recursive: true })
    } catch (err) {
      logMain('ERROR', 'audio:writeTempWav', 'failed to create cache dir:', err)
      return null
    }

    // Include decoded geometry so incompatible re-decodes do not collide.
    const hash = createHash('sha1')
      .update(canonicalisePath(p.sourcePath))
      .update(`|sr=${p.sampleRate}|ch=${chans.length}|n=${frameCount}`)
      .digest('hex')
      .slice(0, 16)
    const outPath = join(TRANSCODE_CACHE_DIR, `${hash}.wav`)

    // Float WAV avoids quantising already-decoded samples.
    const numChannels = chans.length
    const bitsPerSample = 32
    const byteRate = p.sampleRate * numChannels * 4
    const blockAlign = numChannels * 4
    const dataSize = frameCount * blockAlign
    const headerSize = 44
    const buf = Buffer.alloc(headerSize + dataSize)

    let off = 0
    buf.write('RIFF', off)
    off += 4
    buf.writeUInt32LE(headerSize + dataSize - 8, off)
    off += 4
    buf.write('WAVE', off)
    off += 4
    buf.write('fmt ', off)
    off += 4
    buf.writeUInt32LE(16, off)
    off += 4
    buf.writeUInt16LE(3 /* IEEE_FLOAT */, off)
    off += 2
    buf.writeUInt16LE(numChannels, off)
    off += 2
    buf.writeUInt32LE(p.sampleRate, off)
    off += 4
    buf.writeUInt32LE(byteRate, off)
    off += 4
    buf.writeUInt16LE(blockAlign, off)
    off += 2
    buf.writeUInt16LE(bitsPerSample, off)
    off += 2
    buf.write('data', off)
    off += 4
    buf.writeUInt32LE(dataSize, off)
    off += 4
    for (let f = 0; f < frameCount; f++) {
      for (let c = 0; c < numChannels; c++) {
        buf.writeFloatLE(chans[c]![f]!, off)
        off += 4
      }
    }

    try {
      await writeFile(outPath, buf)
    } catch (err) {
      logMain('ERROR', 'audio:writeTempWav', 'failed to write WAV:', err)
      return null
    }
    registerIssuedPath(outPath)
    return outPath
  })
}
