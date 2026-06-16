import { extname, isAbsolute, relative, resolve as pathResolve } from 'node:path'
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
// project's separated stems — a "Stems" folder beside a saved project file. Stem
// sidecar metadata reads/writes are confined to these (or the central stems base).
const stemsWriteRoots: Set<string> = new Set<string>()

// App-derived "Samples" folders beside a project (or in the temp workspace while
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
// samples write root (a project's portable "Samples" subfolder or the temp
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

// Re-check the audio extension at read time as defence in depth.
export function isAllowedAudioPath(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string' || filePath === '') return false
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!AUDIO_FILE_EXTENSIONS_SET.has(ext)) return false
  const canonical = canonicalisePath(filePath)
  return issuedAudioPaths.has(canonical) || isUnderTrustedRoot(canonical)
}
