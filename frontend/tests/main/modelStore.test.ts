import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, stat, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadableStream } from 'node:stream/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HTDEMUCS_FT_MANIFEST, type ModelFile, type ModelManifest, type StemName } from '@main/stems/htdemucsModel'
import {
  ModelStore,
  ModelDownloadError,
  type DownloadProgress,
  type FetchLike,
  type FetchResponse
} from '@main/stems/modelStore'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bytesResponse(bytes: Uint8Array): FetchResponse {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      }
    })
  }
}

function makeFile(stem: StemName, fileName: string, content: Uint8Array): ModelFile {
  return {
    stem,
    fileName,
    url: `https://example.test/${fileName}`,
    sha256: sha256(content),
    sizeBytes: content.length
  }
}

function makeManifest(files: readonly ModelFile[]): ModelManifest {
  return {
    id: 'test-model',
    displayName: 'Test model',
    repo: 'test/repo',
    revision: 'rev-1',
    license: 'MIT',
    stems: files.map((f) => f.stem),
    files,
    totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0)
  }
}

describe('HTDEMUCS_FT_MANIFEST', () => {
  it('describes the four-stem fine-tuned bag', () => {
    expect(HTDEMUCS_FT_MANIFEST.stems).toEqual(['vocals', 'drums', 'bass', 'other'])
    expect(HTDEMUCS_FT_MANIFEST.files).toHaveLength(4)
    expect(HTDEMUCS_FT_MANIFEST.license).toBe('MIT')
  })

  it('totalBytes is the sum of the file sizes', () => {
    const sum = HTDEMUCS_FT_MANIFEST.files.reduce((s, f) => s + f.sizeBytes, 0)
    expect(HTDEMUCS_FT_MANIFEST.totalBytes).toBe(sum)
  })

  it('pins a 64-hex SHA-256 and a revision-locked URL per file', () => {
    for (const file of HTDEMUCS_FT_MANIFEST.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.url).toContain(`/resolve/${HTDEMUCS_FT_MANIFEST.revision}/`)
      expect(file.url).toContain(file.fileName)
    }
  })
})

describe('ModelStore', () => {
  let dir: string
  const vocals = makeFile('vocals', 'vocals.onnx', new Uint8Array([1, 2, 3, 4, 5]))
  const drums = makeFile('drums', 'drums.onnx', new Uint8Array([9, 8, 7, 6]))
  const manifest = makeManifest([vocals, drums])

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'silverdaw-model-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function fakeFetch(map: Record<string, Uint8Array>): FetchLike {
    return vi.fn(async (url: string) => {
      const bytes = map[url]
      if (!bytes) return { ok: false, status: 404, body: null } satisfies FetchResponse
      return bytesResponse(bytes)
    })
  }

  it('reports not-installed on an empty directory', async () => {
    const store = new ModelStore({ manifest, modelDir: dir })
    const state = await store.readInstallState()
    expect(state.installed).toBe(false)
    expect(state.presentBytes).toBe(0)
    expect(state.files.every((f) => !f.present)).toBe(true)
  })

  it('downloads, verifies and commits every file then writes the sentinel', async () => {
    const fetchImpl = fakeFetch({
      [vocals.url]: new Uint8Array([1, 2, 3, 4, 5]),
      [drums.url]: new Uint8Array([9, 8, 7, 6])
    })
    const store = new ModelStore({ manifest, modelDir: dir, fetchImpl })

    const progress: DownloadProgress[] = []
    await store.ensureDownloaded((p) => progress.push(p))

    expect(await store.isInstalled()).toBe(true)
    expect((await stat(store.filePath(vocals))).size).toBe(vocals.sizeBytes)
    expect((await stat(store.filePath(drums))).size).toBe(drums.sizeBytes)
    expect(await readFile(join(dir, '.installed'), 'utf8')).toBe(manifest.revision)

    const last = progress.at(-1)
    expect(last?.receivedBytes).toBe(manifest.totalBytes)
    expect(last?.fileCount).toBe(2)
  })

  it('throws and cleans up the .part file on an integrity mismatch', async () => {
    const fetchImpl = fakeFetch({
      [vocals.url]: new Uint8Array([1, 2, 3, 4, 5]),
      [drums.url]: new Uint8Array([0, 0, 0, 0]) // wrong bytes -> sha256 mismatch
    })
    const store = new ModelStore({ manifest, modelDir: dir, fetchImpl })

    await expect(store.ensureDownloaded()).rejects.toBeInstanceOf(ModelDownloadError)
    await expect(stat(join(dir, 'drums.onnx.part'))).rejects.toThrow()
    await expect(stat(store.filePath(drums))).rejects.toThrow()
    expect(await store.isInstalled()).toBe(false)
  })

  it('skips files already present at the expected size', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(vocalsPathIn(dir), Buffer.from([1, 2, 3, 4, 5]))
    const fetchImpl = fakeFetch({ [drums.url]: new Uint8Array([9, 8, 7, 6]) })
    const store = new ModelStore({ manifest, modelDir: dir, fetchImpl })

    await store.ensureDownloaded()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(drums.url, expect.anything())
    expect(await store.isInstalled()).toBe(true)
  })

  it('is a no-op once installed', async () => {
    const fetchImpl = fakeFetch({
      [vocals.url]: new Uint8Array([1, 2, 3, 4, 5]),
      [drums.url]: new Uint8Array([9, 8, 7, 6])
    })
    const store = new ModelStore({ manifest, modelDir: dir, fetchImpl })
    await store.ensureDownloaded()
    ;(fetchImpl as ReturnType<typeof vi.fn>).mockClear()

    await store.ensureDownloaded()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  describe('inspectDirectory / adoptDirectory', () => {
    it('reports a fully-present directory as installed without a sentinel', async () => {
      await writeFile(vocalsPathIn(dir), Buffer.from([1, 2, 3, 4, 5]))
      await writeFile(join(dir, 'drums.onnx'), Buffer.from([9, 8, 7, 6]))
      const store = new ModelStore({ manifest, modelDir: '/nonexistent' })

      const state = await store.inspectDirectory(dir)
      expect(state.installed).toBe(true)
      expect(state.presentBytes).toBe(manifest.totalBytes)
      // No sentinel exists yet, so the canonical install check is still false.
      await expect(stat(join(dir, '.installed'))).rejects.toThrow()
    })

    it('reports a wrong-sized file as not present', async () => {
      await writeFile(vocalsPathIn(dir), Buffer.from([1, 2, 3]))
      const store = new ModelStore({ manifest, modelDir: '/nonexistent' })
      const state = await store.inspectDirectory(dir)
      expect(state.installed).toBe(false)
      expect(state.files.find((f) => f.file.fileName === 'vocals.onnx')?.present).toBe(false)
    })

    it('adopts a complete directory by stamping the revision sentinel', async () => {
      await writeFile(vocalsPathIn(dir), Buffer.from([1, 2, 3, 4, 5]))
      await writeFile(join(dir, 'drums.onnx'), Buffer.from([9, 8, 7, 6]))
      const store = new ModelStore({ manifest, modelDir: dir })

      await store.adoptDirectory(dir)
      expect(await readFile(join(dir, '.installed'), 'utf8')).toBe(manifest.revision)
      expect(await store.isInstalled()).toBe(true)
    })

    it('refuses to adopt an incomplete directory', async () => {
      await writeFile(vocalsPathIn(dir), Buffer.from([1, 2, 3, 4, 5]))
      const store = new ModelStore({ manifest, modelDir: dir })
      await expect(store.adoptDirectory(dir)).rejects.toBeInstanceOf(ModelDownloadError)
      await expect(stat(join(dir, '.installed'))).rejects.toThrow()
    })
  })
})

function vocalsPathIn(dir: string): string {
  return join(dir, 'vocals.onnx')
}
