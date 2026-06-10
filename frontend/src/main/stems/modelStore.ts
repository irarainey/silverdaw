// Download-on-first-use store for a stem-separation ONNX model.
//
// The model files are large (hundreds of MB each) and MIT-licensed, so rather
// than ship them in the installer we fetch them on first use into the user's
// app-data directory, verifying each file's SHA-256 and byte size before it is
// committed. A `.installed` sentinel records the manifest revision so launches
// after a successful install skip re-hashing ~1.2 GB.
//
// This module is deliberately free of Electron imports: the model directory,
// fetch implementation and clock are injected so it can be unit-tested against
// a real temp directory and a fake `fetch`.

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { ModelFile, ModelManifest } from './htdemucsModel'

export interface ModelFileStatus {
  readonly file: ModelFile
  readonly present: boolean
}

export interface ModelInstallState {
  readonly installed: boolean
  readonly files: readonly ModelFileStatus[]
  readonly presentBytes: number
  readonly totalBytes: number
}

export interface DownloadProgress {
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly fileName: string
  readonly fileIndex: number
  readonly fileCount: number
}

export type ProgressListener = (progress: DownloadProgress) => void

export interface FetchResponse {
  readonly ok: boolean
  readonly status: number
  readonly body: WebReadableStream<Uint8Array> | null
}

export type FetchLike = (
  url: string,
  init?: { readonly signal?: AbortSignal }
) => Promise<FetchResponse>

export interface ModelStoreDeps {
  readonly manifest: ModelManifest
  readonly modelDir: string
  readonly fetchImpl?: FetchLike
}

const SENTINEL_FILE = '.installed'

export class ModelDownloadError extends Error {
  constructor(
    message: string,
    readonly fileName: string
  ) {
    super(message)
    this.name = 'ModelDownloadError'
  }
}

export class ModelStore {
  private readonly manifest: ModelManifest
  private readonly modelDir: string
  private readonly fetchImpl: FetchLike

  constructor(deps: ModelStoreDeps) {
    this.manifest = deps.manifest
    this.modelDir = deps.modelDir
    this.fetchImpl = deps.fetchImpl ?? defaultFetch
  }

  /** Absolute path a committed model file resolves to. */
  filePath(file: ModelFile): string {
    return join(this.modelDir, file.fileName)
  }

  /** Directory holding the model — handed to the backend for ONNX session load. */
  get directory(): string {
    return this.modelDir
  }

  /**
   * Fast presence check (size-only, no hashing). The model counts as installed
   * only when the revision sentinel matches and every file is present at its
   * expected byte size.
   */
  async readInstallState(): Promise<ModelInstallState> {
    const sentinelOk = await this.sentinelMatches()
    const files: ModelFileStatus[] = []
    let presentBytes = 0
    for (const file of this.manifest.files) {
      const present = await this.fileHasExpectedSize(file)
      if (present) presentBytes += file.sizeBytes
      files.push({ file, present })
    }
    const allPresent = files.every((f) => f.present)
    return {
      installed: sentinelOk && allPresent,
      files,
      presentBytes,
      totalBytes: this.manifest.totalBytes
    }
  }

  async isInstalled(): Promise<boolean> {
    return (await this.readInstallState()).installed
  }

  /**
   * Inspect an arbitrary candidate directory (e.g. a user-supplied model the
   * "locate existing model" flow points at) without consulting or writing the
   * revision sentinel. Presence is size-only, mirroring `readInstallState`.
   */
  async inspectDirectory(dir: string): Promise<ModelInstallState> {
    const files: ModelFileStatus[] = []
    let presentBytes = 0
    for (const file of this.manifest.files) {
      const present = await fileHasExpectedSizeIn(dir, file)
      if (present) presentBytes += file.sizeBytes
      files.push({ file, present })
    }
    const allPresent = files.every((f) => f.present)
    return { installed: allPresent, files, presentBytes, totalBytes: this.manifest.totalBytes }
  }

  /**
   * Validate that a user-supplied directory holds every model file at its
   * expected size, then stamp it with the revision sentinel so subsequent
   * install checks treat it as a complete install. Throws `ModelDownloadError`
   * when any file is missing or the wrong size.
   */
  async adoptDirectory(dir: string): Promise<void> {
    const state = await this.inspectDirectory(dir)
    if (!state.installed) {
      const missing = state.files.find((f) => !f.present)?.file.fileName ?? ''
      throw new ModelDownloadError(
        `selected folder is missing required model files (e.g. ${missing || 'unknown'})`,
        missing
      )
    }
    await writeFile(join(dir, SENTINEL_FILE), this.manifest.revision, 'utf8')
  }

  /**
   * Ensure every model file is present and integrity-verified, downloading any
   * that are missing or the wrong size. Re-entrant-safe per call; throws
   * `ModelDownloadError` on network failure or integrity mismatch. Honour an
   * `AbortSignal` so a cancelled download stops promptly.
   */
  async ensureDownloaded(
    onProgress?: ProgressListener,
    signal?: AbortSignal
  ): Promise<void> {
    if (await this.isInstalled()) return
    await mkdir(this.modelDir, { recursive: true })

    const totalBytes = this.manifest.totalBytes
    const fileCount = this.manifest.files.length
    let downloadedBytes = await this.alreadyPresentBytes()

    for (let i = 0; i < fileCount; i++) {
      const file = this.manifest.files[i]
      throwIfAborted(signal)
      if (await this.fileHasExpectedSize(file)) continue

      await this.downloadFile(file, signal, (chunkBytes) => {
        downloadedBytes += chunkBytes
        onProgress?.({
          receivedBytes: downloadedBytes,
          totalBytes,
          fileName: file.fileName,
          fileIndex: i,
          fileCount
        })
      })
    }

    await this.writeSentinel()
  }

  private async downloadFile(
    file: ModelFile,
    signal: AbortSignal | undefined,
    onChunk: (bytes: number) => void
  ): Promise<void> {
    const partPath = join(this.modelDir, `${file.fileName}.part`)
    const finalPath = this.filePath(file)
    const hash = createHash('sha256')

    let response: FetchResponse
    try {
      response = await this.fetchImpl(file.url, { signal })
    } catch (cause) {
      throw new ModelDownloadError(
        `network error fetching ${file.fileName}: ${errorMessage(cause)}`,
        file.fileName
      )
    }
    if (!response.ok || !response.body) {
      throw new ModelDownloadError(
        `unexpected status ${response.status} fetching ${file.fileName}`,
        file.fileName
      )
    }

    const tap = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk)
        onChunk(chunk.length)
        cb(null, chunk)
      }
    })

    try {
      await pipeline(
        Readable.fromWeb(response.body),
        tap,
        createWriteStream(partPath),
        { signal }
      )
    } catch (cause) {
      await rm(partPath, { force: true })
      throw new ModelDownloadError(
        `download interrupted for ${file.fileName}: ${errorMessage(cause)}`,
        file.fileName
      )
    }

    const digest = hash.digest('hex')
    const { size } = await stat(partPath)
    if (digest !== file.sha256 || size !== file.sizeBytes) {
      await rm(partPath, { force: true })
      throw new ModelDownloadError(
        `integrity check failed for ${file.fileName} ` +
          `(sha256 ${digest === file.sha256 ? 'ok' : 'mismatch'}, ` +
          `size ${size}/${file.sizeBytes})`,
        file.fileName
      )
    }

    await rename(partPath, finalPath)
  }

  private async fileHasExpectedSize(file: ModelFile): Promise<boolean> {
    return fileHasExpectedSizeIn(this.modelDir, file)
  }

  private async alreadyPresentBytes(): Promise<number> {
    let bytes = 0
    for (const file of this.manifest.files) {
      if (await this.fileHasExpectedSize(file)) bytes += file.sizeBytes
    }
    return bytes
  }

  private async sentinelMatches(): Promise<boolean> {
    try {
      const text = await readFile(join(this.modelDir, SENTINEL_FILE), 'utf8')
      return text.trim() === this.manifest.revision
    } catch {
      return false
    }
  }

  private async writeSentinel(): Promise<void> {
    await writeFile(join(this.modelDir, SENTINEL_FILE), this.manifest.revision, 'utf8')
  }
}

function defaultFetch(url: string, init?: { readonly signal?: AbortSignal }): Promise<FetchResponse> {
  return fetch(url, { signal: init?.signal }) as unknown as Promise<FetchResponse>
}

async function fileHasExpectedSizeIn(dir: string, file: ModelFile): Promise<boolean> {
  try {
    const { size } = await stat(join(dir, file.fileName))
    return size === file.sizeBytes
  } catch {
    return false
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ModelDownloadError('download aborted', '')
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
