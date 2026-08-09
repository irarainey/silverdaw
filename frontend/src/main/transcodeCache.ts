// The renderer-PCM -> float-WAV transcode cache: where a decoded audition of a
// format the backend cannot read natively is parked so the next play of the
// same file is instant.
//
// These are float32 WAVs — roughly 21 MB per stereo minute at 44.1 kHz — and
// nothing else deletes them, so the cache is swept: entries older than
// `TRANSCODE_CACHE_MAX_AGE_MS` go, and whatever is left is trimmed oldest-first
// until it fits `TRANSCODE_CACHE_MAX_BYTES`. Without that, auditioning a few
// albums of m4a leaves gigabytes behind in the user's temp directory for good.

import { readdir, stat, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logMain } from './log'

let cacheDirOverride: string | null = null

/** Point the cache at a different directory. Used by tests to stay out of temp. */
export function setTranscodeCacheDir(dir: string | null): void {
  cacheDirOverride = dir
}

export function transcodeCacheDir(): string {
  return cacheDirOverride ?? join(tmpdir(), 'silverdaw-transcode-cache')
}

/**
 * How long an unused transcode is kept. Long enough that returning to a project
 * over a working week still finds its auditions cached, short enough that a
 * one-off listen does not occupy the disk indefinitely.
 */
export const TRANSCODE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The ceiling for the whole cache. Reached before the age limit only by heavy
 * use, which is exactly when an unbounded cache would hurt most.
 */
export const TRANSCODE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024

interface CacheFile {
  path: string
  size: number
  /** Last use, not creation: `touchTranscodeCacheEntry` keeps a replayed file young. */
  usedAt: number
}

async function listCacheFiles(dir: string): Promise<CacheFile[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // No cache directory yet is the normal state on a fresh install.
    return []
  }
  const files: CacheFile[] = []
  for (const name of names) {
    if (!name.endsWith('.wav')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.isFile()) files.push({ path, size: info.size, usedAt: info.mtimeMs })
    } catch {
      // Vanished between the listing and the stat — nothing to account for.
    }
  }
  return files
}

async function remove(path: string): Promise<number> {
  try {
    await unlink(path)
    return 1
  } catch (err) {
    logMain('WARN ', 'transcodeCache', 'could not delete:', path, String(err))
    return 0
  }
}

/**
 * Delete expired entries, then trim the oldest until the cache fits its size
 * cap. Safe to run at any time: a transcode deleted while still wanted is
 * simply decoded again on the next play.
 *
 * `limits` exists so the thresholds can be driven directly in tests; production
 * callers pass nothing and get the constants above.
 */
export async function sweepTranscodeCache(limits?: {
  maxAgeMs?: number
  maxBytes?: number
}): Promise<void> {
  const maxAgeMs = limits?.maxAgeMs ?? TRANSCODE_CACHE_MAX_AGE_MS
  const maxBytes = limits?.maxBytes ?? TRANSCODE_CACHE_MAX_BYTES
  const dir = transcodeCacheDir()
  const files = await listCacheFiles(dir)
  if (files.length === 0) return

  const cutoff = Date.now() - maxAgeMs
  const kept: CacheFile[] = []
  let deleted = 0
  for (const file of files) {
    if (file.usedAt < cutoff) deleted += await remove(file.path)
    else kept.push(file)
  }

  let total = kept.reduce((sum, file) => sum + file.size, 0)
  if (total > maxBytes) {
    // Oldest first, so the transcodes in current use are the last to go.
    kept.sort((a, b) => a.usedAt - b.usedAt)
    for (const file of kept) {
      if (total <= maxBytes) break
      if (await remove(file.path)) {
        total -= file.size
        deleted += 1
      }
    }
  }

  if (deleted > 0) {
    logMain('INFO ', 'transcodeCache', `swept ${deleted} cached transcode(s) from ${dir}`)
  }
}

/**
 * Mark a cache hit as used now, so a file played every day is not evicted for
 * being old. Failure is ignored: the entry stays usable, it just ages from its
 * last write instead.
 */
export async function touchTranscodeCacheEntry(path: string): Promise<void> {
  const now = new Date()
  try {
    await utimes(path, now, now)
  } catch {
    // The entry is still valid; only its eviction order is affected.
  }
}
