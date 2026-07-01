// Sweeps EMPTY per-source artifact folders (stems/samples) left under a project's
// write roots. The generated stem/sample WAVs themselves — and pruning the folder a
// last file leaves empty — are deleted by the audio BACKEND over the bridge, which
// owns those files and can remove them even when a cross-process (Electron) unlink is
// blocked by an open handle. This module only clears stray EMPTY folders (e.g. a
// legacy leftover, or one whose files were removed by an older build) when a project's
// roots are (re)registered, so nothing here ever races the backend for an open file.

import { readdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isPrunableArtifactSubdir } from './audioPaths'

// Remove every EMPTY per-source subfolder directly under a stems/samples write root.
// Called when a project's roots are (re)registered so an already-emptied folder from a
// prior session is cleared. Only ever removes an empty directory — never a file.
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
