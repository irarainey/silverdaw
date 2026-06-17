import { extname, isAbsolute, join, relative, resolve as pathResolve } from 'node:path'
import { logMain } from './log'

// Keep accepted audio extensions aligned with backend decoder support.
export const AUDIO_FILE_EXTENSIONS = ['wav', 'mp3', 'flac', 'aiff', 'aif', 'm4a'] as const
const AUDIO_FILE_EXTENSIONS_SET: ReadonlySet<string> = new Set<string>(AUDIO_FILE_EXTENSIONS)

// Renderer may only read audio paths main previously surfaced through trusted UI.
const issuedAudioPaths: Set<string> = new Set<string>()

// App-owned directory trees the renderer may read audio from without each file
// being individually issued — e.g. the stems output dir, which only the backend
// writes to and the renderer can't see file paths for until STEM_READY arrives
// over its direct bridge socket. The audio-extension check still applies.
const trustedReadRoots: Set<string> = new Set<string>()

// App-derived folders (never renderer-supplied) where the backend writes a
// project's separated stems — a "stems" folder beside a saved project file. Stem
// sidecar metadata reads/writes are confined to these (or the central stems base).
const stemsWriteRoots: Set<string> = new Set<string>()

// App-derived "samples" folders beside a project (or in the temp workspace while
// unsaved) where the backend writes exported samples. Music samples persist an
// inherited metadata/cover sidecar in a per-source subdir here; those sidecar
// reads/writes are confined to these roots.
const samplesWriteRoots: Set<string> = new Set<string>()

export function canonicalisePath(p: string): string {
  return pathResolve(p)
}

// Only canonical absolute audio paths can enter the renderer read allow-list.
export function registerIssuedPath(filePath: string): void {
  if (typeof filePath !== 'string' || filePath === '') return
  if (!isAbsolute(filePath)) {
    logMain('WARN ', 'main', 'refusing to register non-absolute path:', filePath)
    return
  }
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!AUDIO_FILE_EXTENSIONS_SET.has(ext)) {
    logMain('WARN ', 'main', 'refusing to register non-audio path:', filePath)
    return
  }
  issuedAudioPaths.add(canonicalisePath(filePath))
}

// Trust an entire app-controlled directory tree for audio reads. Only ever called
// with paths main itself derives (never renderer-supplied).
export function registerTrustedReadRoot(dir: string): void {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) {
    logMain('WARN ', 'main', 'refusing to register non-absolute read root:', dir)
    return
  }
  trustedReadRoots.add(canonicalisePath(dir))
}

function isUnderTrustedRoot(canonical: string): boolean {
  for (const root of trustedReadRoots) {
    const rel = relative(root, canonical)
    // Empty means the path is the root itself; a non-`..`, non-absolute relative
    // path means it lives inside the root (guards against `..` traversal and
    // different-drive paths, which yield an absolute relative on Windows).
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

// Trust a project's stems output folder (derived by main from a save/open path)
// for renderer audio reads AND stem sidecar metadata reads/writes. Idempotent.
export function registerStemsWriteRoot(dir: string): void {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) {
    logMain('WARN ', 'main', 'refusing to register non-absolute stems root:', dir)
    return
  }
  const canonical = canonicalisePath(dir)
  stemsWriteRoots.add(canonical)
  trustedReadRoots.add(canonical)
}

// A stem sidecar folder is writable only when it sits inside a registered stems
// write root. (The central stems base is checked separately by the caller.)
export function isWithinStemsWriteRoot(dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return false
  const canonical = canonicalisePath(dir)
  for (const root of stemsWriteRoots) {
    const rel = relative(root, canonical)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

// Trust a project's Samples output folder (derived by main from a save/open path)
// for renderer audio reads AND sample sidecar metadata reads/writes. Idempotent.
export function registerSamplesWriteRoot(dir: string): void {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) {
    logMain('WARN ', 'main', 'refusing to register non-absolute samples root:', dir)
    return
  }
  const canonical = canonicalisePath(dir)
  samplesWriteRoots.add(canonical)
  trustedReadRoots.add(canonical)
}

// A sample sidecar folder is writable only when it sits inside a registered
// samples write root (a project's portable "samples" subfolder or the temp
// workspace one used before the project is saved).
export function isWithinSamplesWriteRoot(dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return false
  const canonical = canonicalisePath(dir)
  for (const root of samplesWriteRoots) {
    const rel = relative(root, canonical)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

// True only for a path STRICTLY inside a stems or samples write root — i.e. a
// per-source subfolder, never a root itself. Used to safely prune an emptied
// per-source artifact folder after its files are cleaned up, without ever
// removing the top-level stems/samples folder.
export function isPrunableArtifactSubdir(dir: unknown): dir is string {
  if (typeof dir !== 'string' || dir === '' || !isAbsolute(dir)) return false
  const canonical = canonicalisePath(dir)
  for (const root of [...stemsWriteRoots, ...samplesWriteRoots]) {
    const rel = relative(root, canonical)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return true
  }
  return false
}

// The active project's central media store: one `metadata/` (per-source tag JSON)
// and one `covers/` (per-source cover image) folder beside the project file, both
// keyed by the source's media GUID. Tracks the most-recently opened/saved project
// (Silverdaw is single-project), or the temp workspace while unsaved. The store is
// the single source of truth for cover art + tags, shared by an imported file and
// every stem/sample derived from it.
let currentMetadataDir: string | null = null
let currentCoversDir: string | null = null

export function registerProjectMediaRoots(projectDir: string): void {
  if (typeof projectDir !== 'string' || projectDir === '' || !isAbsolute(projectDir)) {
    logMain('WARN ', 'main', 'refusing to register non-absolute project media root:', projectDir)
    return
  }
  currentMetadataDir = canonicalisePath(join(projectDir, 'metadata'))
  currentCoversDir = canonicalisePath(join(projectDir, 'covers'))
}

export function getProjectMediaDirs(): { metadataDir: string; coversDir: string } | null {
  return currentMetadataDir !== null && currentCoversDir !== null
    ? { metadataDir: currentMetadataDir, coversDir: currentCoversDir }
    : null
}

// Re-check the audio extension at read time as defence in depth.
export function isAllowedAudioPath(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string' || filePath === '') return false
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!AUDIO_FILE_EXTENSIONS_SET.has(ext)) return false
  const canonical = canonicalisePath(filePath)
  return issuedAudioPaths.has(canonical) || isUnderTrustedRoot(canonical)
}
