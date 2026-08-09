// Coverage for the audition transcode cache's eviction. The cached WAVs are
// float32 — around 21 MB per stereo minute — and nothing else on the system
// removes them, so an unswept cache quietly fills the user's temp directory.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/main/log', () => ({ logMain: vi.fn() }))

import {
  setTranscodeCacheDir,
  sweepTranscodeCache,
  touchTranscodeCacheEntry,
  transcodeCacheDir,
  TRANSCODE_CACHE_MAX_AGE_MS,
  TRANSCODE_CACHE_MAX_BYTES
} from '../../src/main/transcodeCache'

let dir: string

/** Write a cache entry of `size` bytes, last used `ageMs` ago. */
async function entry(name: string, size: number, ageMs = 0): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, Buffer.alloc(size))
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
  return path
}

async function remaining(): Promise<string[]> {
  return (await readdir(dir)).sort()
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'silverdaw-transcode-test-'))
  setTranscodeCacheDir(dir)
})

afterEach(async () => {
  setTranscodeCacheDir(null)
  await rm(dir, { recursive: true, force: true })
})

describe('transcode cache eviction', () => {
  it('deletes entries past the age limit and keeps the rest', async () => {
    await entry('old.wav', 16, TRANSCODE_CACHE_MAX_AGE_MS + 60_000)
    await entry('fresh.wav', 16, 1_000)

    await sweepTranscodeCache()

    expect(await remaining()).toEqual(['fresh.wav'])
  })

  it('leaves files it does not own alone', async () => {
    await entry('cached.wav', 16, TRANSCODE_CACHE_MAX_AGE_MS + 60_000)
    // Aged past the limit too, so only the extension check can save it — a
    // fresh file would survive on its age and prove nothing.
    const foreign = join(dir, 'notes.txt')
    await writeFile(foreign, 'not ours')
    const when = new Date(Date.now() - TRANSCODE_CACHE_MAX_AGE_MS - 60_000)
    await utimes(foreign, when, when)

    await sweepTranscodeCache()

    expect(await remaining()).toEqual(['notes.txt'])
  })

  it('trims the oldest first once the cache is over its size cap', async () => {
    await entry('oldest.wav', 100, 30_000)
    await entry('middle.wav', 100, 20_000)
    await entry('newest.wav', 100, 10_000)

    // Room for one entry only: the two least recently used have to go, and the
    // one in most recent use has to survive.
    await sweepTranscodeCache({ maxBytes: 150 })

    expect(await remaining()).toEqual(['newest.wav'])
  })

  it('keeps everything while the cache is under its cap', async () => {
    await entry('a.wav', 100, 30_000)
    await entry('b.wav', 100, 10_000)

    await sweepTranscodeCache({ maxBytes: 1_000 })

    expect(await remaining()).toEqual(['a.wav', 'b.wav'])
  })

  it('keeps a touched entry that would otherwise have expired', async () => {
    const path = await entry('replayed.wav', 16, TRANSCODE_CACHE_MAX_AGE_MS + 60_000)

    // A cache hit reuses the file without rewriting it, so without the touch it
    // would keep ageing from its first write and be evicted while still in
    // daily use.
    await touchTranscodeCacheEntry(path)
    await sweepTranscodeCache()

    expect(await remaining()).toEqual(['replayed.wav'])
  })

  it('does nothing when the cache directory does not exist', async () => {
    setTranscodeCacheDir(join(dir, 'missing'))

    await expect(sweepTranscodeCache()).resolves.toBeUndefined()
  })

  it('has a default cap and a directory of its own', async () => {
    setTranscodeCacheDir(null)

    expect(transcodeCacheDir()).toBe(join(tmpdir(), 'silverdaw-transcode-cache'))
    expect(TRANSCODE_CACHE_MAX_BYTES).toBeGreaterThan(0)
  })
})
