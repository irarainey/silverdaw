// Audio IPC handlers: file open/import dialogs, allow-listed reads, metadata,
// and the renderer-PCM -> float-WAV transcode cache. Registered from main/index.ts.

import { ipcMain, dialog, app, type BrowserWindow } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { parseFile } from 'music-metadata'
import { IPC } from '../../shared/ipc-channels'
import { normalizeMetadata } from '../audioMetadata'
import type { AudioMetadata } from '../../shared/types'
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

// Stem sidecar: a stem's separated WAV carries no tags, so we copy the source
// file's metadata + cover art into the stem's output folder at separation time.
// This makes a stem's inherited identity survive removal of the original source
// item and a project reload (the live derivedFrom reference dangles once the
// source is gone).
const SIDECAR_METADATA_FILE = 'metadata.json'

interface StemSidecar {
  version: number
  metadata: AudioMetadata
  cover?: { file: string; mimeType: string }
}

const COVER_EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

function coverExtForMime(mime: string): string {
  return COVER_EXT_BY_MIME[mime.toLowerCase()] ?? 'img'
}

// The app-owned stems base dir (JUCE userApplicationDataDirectory == appData on
// Windows). Sidecar reads/writes are confined to folders beneath it.
function stemsBaseDir(): string {
  return canonicalisePath(join(app.getPath('appData'), 'Silverdaw', 'stems'))
}

function isWithinStemsDir(dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return false
  const rel = relative(stemsBaseDir(), canonicalisePath(dir))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

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

  // Write a stem's source metadata + cover art into the stem output folder so the
  // inherited identity is a real copy, independent of the source file once written.
  ipcMain.handle(IPC.stems.writeSidecar, async (_evt, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return false
    const p = payload as { stemDir?: unknown; sourceFilePath?: unknown }
    if (!isWithinStemsDir(p.stemDir)) {
      logMain('WARN ', 'stems:writeSidecar', 'rejected stemDir not under stems base:', p.stemDir)
      return false
    }
    if (!isAllowedAudioPath(p.sourceFilePath)) {
      logMain('WARN ', 'stems:writeSidecar', 'rejected source not on allow-list:', p.sourceFilePath)
      return false
    }
    try {
      const meta = normalizeMetadata(
        await parseFile(p.sourceFilePath, { duration: true, skipCovers: false })
      )
      const dir = canonicalisePath(p.stemDir)
      await mkdir(dir, { recursive: true })
      const { coverArt, ...rest } = meta
      const sidecar: StemSidecar = { version: 1, metadata: rest }
      if (coverArt && coverArt.data.byteLength > 0) {
        const file = `cover.${coverExtForMime(coverArt.mimeType)}`
        await writeFile(join(dir, file), Buffer.from(coverArt.data))
        sidecar.cover = { file, mimeType: coverArt.mimeType }
      }
      await writeFile(join(dir, SIDECAR_METADATA_FILE), JSON.stringify(sidecar, null, 2), 'utf8')
      return true
    } catch (err) {
      logMain('WARN ', 'stems:writeSidecar', `failed for ${String(p.sourceFilePath)}:`, err)
      return false
    }
  })

  // Read back a stem sidecar as AudioMetadata (cover bytes attached) so the
  // existing setItemMetadata Blob-URL flow works unchanged. Returns null when no
  // sidecar is present so the caller can fall back to reading the file's own tags.
  ipcMain.handle(IPC.stems.readSidecar, async (_evt, stemDir: unknown) => {
    if (!isWithinStemsDir(stemDir)) {
      logMain('WARN ', 'stems:readSidecar', 'rejected stemDir not under stems base:', stemDir)
      return null
    }
    try {
      const dir = canonicalisePath(stemDir)
      const raw = await readFile(join(dir, SIDECAR_METADATA_FILE), 'utf8')
      const parsed = JSON.parse(raw) as Partial<StemSidecar>
      if (!parsed || typeof parsed.metadata !== 'object' || parsed.metadata === null) return null
      const meta: AudioMetadata = { ...parsed.metadata }
      if (parsed.cover && typeof parsed.cover.file === 'string') {
        try {
          const buf = await readFile(join(dir, basename(parsed.cover.file)))
          const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
          meta.coverArt = { data, mimeType: parsed.cover.mimeType || 'image/jpeg' }
        } catch (err) {
          logMain('WARN ', 'stems:readSidecar', `cover read failed in ${dir}:`, err)
        }
      }
      return meta
    } catch {
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
