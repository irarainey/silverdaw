// Audio IPC handlers: file open/import dialogs, allow-listed reads, metadata,
// and the renderer-PCM -> float-WAV transcode cache. Registered from main/index.ts.

import { ipcMain, dialog, app, type BrowserWindow } from 'electron'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
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
  isWithinStemsWriteRoot,
  isWithinSamplesWriteRoot,
  getProjectMediaDirs,
  registerIssuedPath
} from '../audioPaths'
import { logMain } from '../log'
import { cleanupArtifactWavs } from '../projectFileCleanup'

/** Singletons the audio handlers reach back into main for. */
export interface AudioHandlersContext {
  getMainWindow(): BrowserWindow | null
  getCurrentClipDir(): string
  setCurrentClipDir(dir: string): void
}

// Cache renderer-side transcodes by source path and decoded geometry.
const TRANSCODE_CACHE_DIR = join(tmpdir(), 'silverdaw-transcode-cache')

// Media sidecar: a generated WAV (a separated stem, or a music sample saved from
// a clip) carries no embedded tags, so we copy the source file's metadata + cover
// art into the generated file's folder at creation time. This makes the inherited
// identity a real, self-contained copy that survives removal of the original
// source item and a project reload (the live `derivedFrom`/source reference
// dangles once the source is gone). Stems and music samples share this format.
const SIDECAR_METADATA_FILE = 'metadata.json'

interface MediaSidecar {
  version: number
  metadata: AudioMetadata
  cover?: { file: string; mimeType: string }
}

interface SidecarCover {
  data: ArrayBuffer
  mimeType: string
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

// Sidecar reads/writes are confined to the central stems base or a registered
// per-project stems folder (a saved project's portable "stems" subfolder).
function isWithinStemsDir(dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return false
  const rel = relative(stemsBaseDir(), canonicalisePath(dir))
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true
  return isWithinStemsWriteRoot(dir)
}

// Write an already-resolved identity (tags + optional cover bytes) as a sidecar
// (metadata.json plus a cover.<ext>) into an app-owned `dir`. Shared by both the
// stem and sample writers — the difference is only how the identity is sourced:
// stems re-parse the original tagged source file; samples pass the in-memory
// inherited identity (their source may be a tagless stem/library-clip, so the file
// on disk has nothing to parse).
async function writeSidecarData(
  dir: string,
  metadata: AudioMetadata,
  cover?: SidecarCover
): Promise<boolean> {
  await mkdir(dir, { recursive: true })
  const { coverArt: _omitCover, ...rest } = metadata
  const sidecar: MediaSidecar = { version: 1, metadata: rest }
  if (cover && cover.data.byteLength > 0) {
    const file = `cover.${coverExtForMime(cover.mimeType)}`
    await writeFile(join(dir, file), Buffer.from(cover.data))
    sidecar.cover = { file, mimeType: cover.mimeType }
  }
  await writeFile(join(dir, SIDECAR_METADATA_FILE), JSON.stringify(sidecar, null, 2), 'utf8')
  return true
}

// Parse a tagged source file's metadata + cover art and persist it as a sidecar
// into an already-validated `dir`. Used by the stem writer (the source is the
// original imported file, which carries real tags).
async function writeSidecarToDir(dir: string, sourceFilePath: string): Promise<boolean> {
  const meta = normalizeMetadata(await parseFile(sourceFilePath, { duration: true, skipCovers: false }))
  const { coverArt, ...rest } = meta
  const cover =
    coverArt && coverArt.data.byteLength > 0
      ? { data: coverArt.data, mimeType: coverArt.mimeType }
      : undefined
  return writeSidecarData(dir, rest, cover)
}

// Read a sidecar from an already-validated `dir` back into `AudioMetadata` (cover
// bytes attached) so the existing setItemMetadata Blob-URL flow works unchanged.
// Returns null when no sidecar is present so the caller can fall back to the
// file's own tags. Shared by the stem and sample read handlers.
async function readSidecarFromDir(dir: string): Promise<AudioMetadata | null> {
  const raw = await readFile(join(dir, SIDECAR_METADATA_FILE), 'utf8')
  const parsed = JSON.parse(raw) as Partial<MediaSidecar>
  if (!parsed || typeof parsed.metadata !== 'object' || parsed.metadata === null) return null
  const meta: AudioMetadata = { ...parsed.metadata }
  if (parsed.cover && typeof parsed.cover.file === 'string') {
    try {
      const buf = await readFile(join(dir, basename(parsed.cover.file)))
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      meta.coverArt = { data, mimeType: parsed.cover.mimeType || 'image/jpeg' }
    } catch (err) {
      logMain('WARN ', 'sidecar:read', `cover read failed in ${dir}:`, err)
    }
  }
  return meta
}

// ── Central project media store (keyed by media GUID) ────────────────────────
// One `metadata/<guid>.json` (tags) + `covers/<guid>.<ext>` (cover image) per
// source file, beside the project. Reuses the sidecar record shape; the only
// difference from the per-item sidecars is the GUID filename and the flat folders,
// so an imported file and every stem/sample derived from it share one entry.
async function writeProjectMediaFiles(
  metadataDir: string,
  coversDir: string,
  guid: string,
  metadata: AudioMetadata,
  cover?: SidecarCover
): Promise<boolean> {
  await mkdir(metadataDir, { recursive: true })
  const { coverArt: _omitCover, ...rest } = metadata
  const record: MediaSidecar = { version: 1, metadata: rest }
  if (cover && cover.data.byteLength > 0) {
    await mkdir(coversDir, { recursive: true })
    const file = `${guid}.${coverExtForMime(cover.mimeType)}`
    await writeFile(join(coversDir, file), Buffer.from(cover.data))
    record.cover = { file, mimeType: cover.mimeType }
  }
  await writeFile(join(metadataDir, `${guid}.json`), JSON.stringify(record, null, 2), 'utf8')
  return true
}

async function readProjectMediaFiles(
  metadataDir: string,
  coversDir: string,
  guid: string
): Promise<AudioMetadata | null> {
  let raw: string
  try {
    raw = await readFile(join(metadataDir, `${guid}.json`), 'utf8')
  } catch {
    return null
  }
  const parsed = JSON.parse(raw) as Partial<MediaSidecar>
  if (!parsed || typeof parsed.metadata !== 'object' || parsed.metadata === null) return null
  const meta: AudioMetadata = { ...parsed.metadata }
  if (parsed.cover && typeof parsed.cover.file === 'string') {
    try {
      const buf = await readFile(join(coversDir, basename(parsed.cover.file)))
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      meta.coverArt = { data, mimeType: parsed.cover.mimeType || 'image/jpeg' }
    } catch (err) {
      logMain('WARN ', 'media:get', `cover read failed for ${guid}:`, err)
    }
  }
  return meta
}

// A media GUID names exactly one `<guid>.json` + one `<guid>.<ext>` cover. Reject
// anything that could escape the store directories (path separators / traversal).
function isSafeMediaGuid(guid: unknown): guid is string {
  return typeof guid === 'string' && guid.length > 0 && /^[A-Za-z0-9._-]+$/.test(guid)
}

// Delete a media-store entry (`<guid>.json` + its cover) when the renderer has
// determined no remaining library item references the GUID. Best-effort.
async function deleteOrphanMedia(guid: string, metadataDir: string, coversDir: string): Promise<void> {
  if (!isSafeMediaGuid(guid)) return
  // Read the record first so we delete the exact cover file it points at.
  try {
    const raw = await readFile(join(metadataDir, `${guid}.json`), 'utf8')
    const parsed = JSON.parse(raw) as Partial<MediaSidecar>
    const coverFile = parsed?.cover?.file
    if (typeof coverFile === 'string' && coverFile.length > 0) {
      await unlink(join(coversDir, basename(coverFile))).catch(() => {})
    }
  } catch {
    // No record (or unreadable) — still try to remove the json below.
  }
  await unlink(join(metadataDir, `${guid}.json`)).catch(() => {})
}

// Resolve a music sample's inherited identity (tags + cover art) from its source's
// on-disk representation, mirroring however the source itself stores its identity:
//  - a separated stem (or a music sample) is a tagless WAV whose identity lives in
//    its OWN sidecar beside it — prefer that (this is the common case);
//  - an imported audio file carries embedded tags + cover — parse them.
// Returns null only when neither yields anything usable. The source sidecar lookup
// is gated to app-owned folders so an unrelated metadata.json beside a user's music
// file can never be mistaken for the source's identity.
async function resolveSourceIdentity(
  sourceFilePath: string
): Promise<{ metadata: AudioMetadata; cover?: SidecarCover } | null> {
  const splitCover = (meta: AudioMetadata): { metadata: AudioMetadata; cover?: SidecarCover } => {
    const { coverArt, ...rest } = meta
    return {
      metadata: rest,
      cover:
        coverArt && coverArt.data.byteLength > 0
          ? { data: coverArt.data, mimeType: coverArt.mimeType }
          : undefined
    }
  }
  const sourceDir = canonicalisePath(dirname(sourceFilePath))
  if (isWithinStemsDir(sourceDir) || isWithinSamplesWriteRoot(sourceDir)) {
    try {
      const sidecar = await readSidecarFromDir(sourceDir)
      if (sidecar) return splitCover(sidecar)
    } catch {
      /* fall through to parsing the file's own tags */
    }
  }
  try {
    return splitCover(normalizeMetadata(await parseFile(sourceFilePath, { duration: true, skipCovers: false })))
  } catch (err) {
    logMain('WARN ', 'samples:writeSidecar', `could not resolve identity for ${sourceFilePath}:`, err)
    return null
  }
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
      return await writeSidecarToDir(canonicalisePath(p.stemDir), p.sourceFilePath)
    } catch (err) {
      logMain('WARN ', 'stems:writeSidecar', `failed for ${String(p.sourceFilePath)}:`, err)
      return false
    }
  })

  // Read back a stem sidecar as AudioMetadata (cover bytes attached). Returns null
  // when no sidecar is present so the caller can fall back to the file's own tags.
  ipcMain.handle(IPC.stems.readSidecar, async (_evt, stemDir: unknown) => {
    if (!isWithinStemsDir(stemDir)) {
      logMain('WARN ', 'stems:readSidecar', 'rejected stemDir not under stems base:', stemDir)
      return null
    }
    try {
      return await readSidecarFromDir(canonicalisePath(stemDir))
    } catch {
      return null
    }
  })

  // Music samples persist their inherited identity (tags + cover) as a sidecar
  // beside the WAV, the same format stems use. The renderer passes only the sample
  // WAV path + its source path; main resolves the identity from the source's
  // on-disk representation (its own sidecar when the source is a tagless stem/
  // sample, else the file's embedded tags) — the renderer cannot supply the cover
  // bytes (the library store keeps only a Blob URL the renderer CSP can't fetch).
  // The sidecar folder is the WAV's parent dir (the per-source subdir the backend
  // wrote into), confined to a Samples write root.
  ipcMain.handle(IPC.samples.writeSidecar, async (_evt, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return false
    const p = payload as { sampleFilePath?: unknown; sourceFilePath?: unknown }
    if (typeof p.sampleFilePath !== 'string' || typeof p.sourceFilePath !== 'string') return false
    if (!isAllowedAudioPath(p.sourceFilePath)) {
      logMain('WARN ', 'samples:writeSidecar', 'rejected source not on allow-list:', p.sourceFilePath)
      return false
    }
    const dir = canonicalisePath(dirname(p.sampleFilePath))
    if (!isWithinSamplesWriteRoot(dir)) {
      logMain('WARN ', 'samples:writeSidecar', 'rejected sampleDir not under samples root:', dir)
      return false
    }
    try {
      const identity = await resolveSourceIdentity(p.sourceFilePath)
      if (!identity) return false
      return await writeSidecarData(dir, identity.metadata, identity.cover)
    } catch (err) {
      logMain('WARN ', 'samples:writeSidecar', `failed for ${String(p.sampleFilePath)}:`, err)
      return false
    }
  })

  // Read back a music sample's sidecar as AudioMetadata (cover bytes attached) on
  // project reload. Returns null when absent so the caller falls back to basic
  // file info.
  ipcMain.handle(IPC.samples.readSidecar, async (_evt, sampleDir: unknown) => {
    if (!isWithinSamplesWriteRoot(sampleDir)) {
      logMain('WARN ', 'samples:readSidecar', 'rejected sampleDir not under samples root:', sampleDir)
      return null
    }
    try {
      return await readSidecarFromDir(canonicalisePath(sampleDir))
    } catch {
      return null
    }
  })

  // ── Central project media store (keyed by media GUID) ──────────────────────
  // Save a source file's tags + cover art into the active project's metadata/covers
  // store under its media GUID. The renderer passes the GUID it minted at import and
  // the source file path; main resolves the identity from the source's on-disk form
  // (embedded tags for an imported file, or a sidecar for a tagless stem/sample) so
  // the renderer never needs the cover bytes. Confined to the registered project
  // media dirs; the source must be on the audio allow-list.
  ipcMain.handle(IPC.media.save, async (_evt, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return false
    const p = payload as { mediaId?: unknown; sourceFilePath?: unknown }
    if (typeof p.mediaId !== 'string' || p.mediaId === '' || typeof p.sourceFilePath !== 'string') return false
    if (!isAllowedAudioPath(p.sourceFilePath)) {
      logMain('WARN ', 'media:save', 'rejected source not on allow-list:', p.sourceFilePath)
      return false
    }
    const dirs = getProjectMediaDirs()
    if (!dirs) {
      logMain('WARN ', 'media:save', 'no active project media store')
      return false
    }
    try {
      const identity = await resolveSourceIdentity(p.sourceFilePath)
      if (!identity) return false
      return await writeProjectMediaFiles(dirs.metadataDir, dirs.coversDir, p.mediaId, identity.metadata, identity.cover)
    } catch (err) {
      logMain('WARN ', 'media:save', `failed for ${String(p.mediaId)}:`, err)
      return false
    }
  })

  // Read a source's media back as AudioMetadata (cover bytes attached) by GUID, for
  // any imported file / stem / sample that shares it. Returns null when absent.
  ipcMain.handle(IPC.media.get, async (_evt, mediaId: unknown) => {
    if (typeof mediaId !== 'string' || mediaId === '') return null
    const dirs = getProjectMediaDirs()
    if (!dirs) return null
    try {
      return await readProjectMediaFiles(dirs.metadataDir, dirs.coversDir, mediaId)
    } catch {
      return null
    }
  })

  // Delete a removed library item's generated files: stem/sample WAVs (confined to
  // the stems/samples write roots, with empty per-source folders pruned) and any
  // media-store entries the renderer found are no longer referenced. Gated behind
  // the renderer's "clean up project files" preference; best-effort and never
  // touches a user's original imported audio.
  ipcMain.handle(IPC.media.cleanup, async (_evt, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return false
    const p = payload as { wavPaths?: unknown; mediaIds?: unknown }
    const wavPaths = Array.isArray(p.wavPaths) ? p.wavPaths : []
    const mediaIds = Array.isArray(p.mediaIds) ? p.mediaIds : []
    // Delete the artifact WAVs and prune any emptied per-source folders.
    await cleanupArtifactWavs(wavPaths)
    if (mediaIds.length > 0) {
      const dirs = getProjectMediaDirs()
      if (dirs) {
        for (const id of mediaIds) {
          if (typeof id === 'string') await deleteOrphanMedia(id, dirs.metadataDir, dirs.coversDir)
        }
      }
    }
    return true
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
