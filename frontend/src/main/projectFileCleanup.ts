// Deletes a removed library item's generated artifact files (separated-stem and
// exported-sample WAVs) and prunes the per-source folder they leave behind. Pure
// fs + path-allow-list logic, kept free of Electron so it is unit-testable against a
// real temp directory. The media-store (cover/tag) cleanup lives with the media
// handlers; this module owns only the stems/samples WAVs and their folders.
//
// A just-emptied folder can refuse removal (EPERM/EBUSY) while a sync client
// (OneDrive), AV scanner, or a lingering reader still holds it. Rather than block the
// caller, failed folder removals are queued and retried in the background over a
// window; anything still locked is also swept the next time its project opens.

import { unlink, readdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import {
  canonicalisePath,
  isWithinStemsWriteRoot,
  isWithinSamplesWriteRoot,
  isPrunableArtifactSubdir
} from './audioPaths'
import { logMain } from './log'

// ─── Deferred folder-removal retry queue ──────────────────────────────────────

const RETRY_INTERVAL_MS = 3000
const MAX_RETRY_ATTEMPTS = 40 // ~2 minutes of background retries
const pendingFolders = new Map<string, number>() // dir -> attempts so far
let retryTimer: ReturnType<typeof setInterval> | null = null

function scheduleFolderRemoval(dir: string): void {
  if (!pendingFolders.has(dir)) pendingFolders.set(dir, 0)
  if (retryTimer !== null) return
  retryTimer = setInterval(() => {
    void drainPendingFolders()
  }, RETRY_INTERVAL_MS)
  // Don't let the retry timer keep the process alive at quit.
  if (typeof retryTimer.unref === 'function') retryTimer.unref()
}

async function drainPendingFolders(): Promise<void> {
  for (const [dir, attempts] of [...pendingFolders]) {
    const outcome = await tryRemovePrunableFolder(dir)
    if (outcome === 'done') {
      pendingFolders.delete(dir)
    } else if (attempts + 1 >= MAX_RETRY_ATTEMPTS) {
      logMain('WARN ', 'media:cleanup', `gave up removing folder after retries: ${dir}`)
      pendingFolders.delete(dir)
    } else {
      pendingFolders.set(dir, attempts + 1)
    }
  }
  if (pendingFolders.size === 0 && retryTimer !== null) {
    clearInterval(retryTimer)
    retryTimer = null
  }
}

// Try to remove an empty, prunable per-source folder. 'done' = gone / no longer ours
// / now holds other files (stop trying); 'retry' = still locked (try again later).
async function tryRemovePrunableFolder(dir: string): Promise<'done' | 'retry'> {
  if (!isPrunableArtifactSubdir(dir)) return 'done'
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'done' : 'retry'
  }
  if (entries.length !== 0) return 'done' // something else lives here now — leave it
  try {
    await rm(dir, { recursive: true, force: true })
    return 'done'
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'done' : 'retry'
  }
}

// ─── WAV + folder deletion ────────────────────────────────────────────────────

// Validate a renderer-supplied artifact path: it must be an absolute file inside a
// registered stems/samples write root, so a user's original imported source can never
// be deleted. Returns the canonical path and its parent folder, else null.
function validateArtifactWav(filePath: unknown): { canonical: string; parent: string } | null {
  if (typeof filePath !== 'string' || filePath === '' || !isAbsolute(filePath)) return null
  if (!isWithinStemsWriteRoot(filePath) && !isWithinSamplesWriteRoot(filePath)) {
    logMain('WARN ', 'media:cleanup', 'refusing to delete file outside stems/samples roots:', filePath)
    return null
  }
  const canonical = canonicalisePath(filePath)
  return { canonical, parent: dirname(canonical) }
}

async function unlinkBestEffort(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logMain('WARN ', 'media:cleanup', `wav delete failed for ${file}:`, err)
    }
  }
}

// Remove a whole per-source folder (its files AND the directory) in one recursive
// `rm`. Returns true when the directory is gone, false when it survived (locked) so
// the caller can queue a deferred retry. On failure our own files are still unlinked.
async function removeArtifactFolder(dir: string, fileBasenames: ReadonlySet<string>): Promise<boolean> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return true
    for (const name of fileBasenames) await unlinkBestEffort(join(dir, name))
    return false
  }
}

// Delete the given artifact WAVs and prune the per-source folders they leave empty.
// When deleting a folder's files would empty it, the folder is removed wholesale
// (files + directory together) rather than file-then-empty-directory. A folder that
// still holds OTHER (unknown) files is never recursively removed. A folder that can't
// be removed right now (locked) is queued for background retries.
export async function cleanupArtifactWavs(wavPaths: readonly unknown[]): Promise<void> {
  const byParent = new Map<string, Set<string>>()
  const looseWavs: string[] = []
  for (const wav of wavPaths) {
    const info = validateArtifactWav(wav)
    if (!info) continue
    if (isPrunableArtifactSubdir(info.parent)) {
      let names = byParent.get(info.parent)
      if (!names) {
        names = new Set<string>()
        byParent.set(info.parent, names)
      }
      names.add(basename(info.canonical))
    } else {
      // Directly under a write root (not the case in practice) — only ever unlink the
      // file; never remove a root folder.
      looseWavs.push(info.canonical)
    }
  }

  for (const wav of looseWavs) await unlinkBestEffort(wav)

  for (const [parent, toDelete] of byParent) {
    let entries: string[]
    try {
      entries = await readdir(parent)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logMain('WARN ', 'media:cleanup', `could not read folder ${parent}:`, err)
      }
      continue
    }
    if (entries.length === 0 || entries.every((name) => toDelete.has(name))) {
      const removed = await removeArtifactFolder(parent, toDelete)
      if (!removed) scheduleFolderRemoval(parent)
    } else {
      for (const name of toDelete) await unlinkBestEffort(join(parent, name))
    }
  }
}

// Remove every EMPTY per-source subfolder directly under a stems/samples write root.
// Called when a project's roots are (re)registered so a folder left locked in a prior
// session — its files already deleted — is cleared once the lock is gone.
export async function sweepEmptyArtifactSubdirs(rootDir: unknown): Promise<void> {
  if (typeof rootDir !== 'string' || rootDir === '' || !isAbsolute(rootDir)) return
  let children: string[]
  try {
    children = await readdir(rootDir)
  } catch {
    return // root doesn't exist yet — nothing to sweep
  }
  for (const name of children) {
    const dir = join(rootDir, name)
    if (!isPrunableArtifactSubdir(dir)) continue
    try {
      const entries = await readdir(dir)
      if (entries.length === 0) await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } catch {
      // Not a directory, not empty, or still locked — leave it.
    }
  }
}
