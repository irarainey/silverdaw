import type { ProjectStateTransition } from '@shared/bridge-protocol'
import type { Transition } from './projectTypes'

/**
 * Stable `projectId` from an absolute path, used to bucket autosave artefacts.
 * Prefers SHA-1 (8-byte prefix); falls back to a deterministic hash without Web Crypto.
 */
export async function deriveProjectIdFromPath(absolutePath: string): Promise<string> {
  const lower = absolutePath.trim().toLowerCase()
  try {
    const subtle = (globalThis.crypto as Crypto | undefined)?.subtle
    if (subtle) {
      const data = new TextEncoder().encode(lower)
      const digest = await subtle.digest('SHA-1', data)
      return Array.from(new Uint8Array(digest))
        .slice(0, 8)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
  } catch {
    // Fall through to the synchronous fallback.
  }
  // Deterministic FNV-1a fallback for environments without Web Crypto.
  let h = 0x811c9dc5
  for (let i = 0; i < lower.length; i++) {
    h ^= lower.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Fresh autosave id for an untitled project; matches main's [A-Za-z0-9_-]{1,64} allow-list. */
export function freshUntitledProjectId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 24)
  // Test-environment fallback; Math.random() entropy is fine here.
  let out = ''
  for (let i = 0; i < 24; i++) {
    out += Math.floor(Math.random() * 16).toString(16)
  }
  return out
}

export function fileStem(name: string): string {
  return name.replace(/\.[^.\\/:*?"<>|]+$/, '').trim() || 'Sample'
}

export function parentDir(path: string | null | undefined): string {
  if (!path) return ''
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return slash > 0 ? path.slice(0, slash) : ''
}

/** Map wire-format transitions to the store shape; undefined for an empty list (suppressed default). */
export function hydrateTransitions(
  raw: readonly ProjectStateTransition[] | undefined
): Transition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  return raw.map((tr) => ({
    id: tr.id,
    leftClipId: tr.leftClipId,
    rightClipId: tr.rightClipId,
    recipe: tr.recipe
  }))
}

/**
 * Derive a clip's display name from its backend file path. Strips the directory
 * and extension; falls back to the full string if either step can't apply.
 */
export function filePathToDisplayName(filePath: string): string {
  // Handle both Windows backslash and POSIX forward-slash separators.
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const basename = lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath
  const lastDot = basename.lastIndexOf('.')
  return lastDot > 0 ? basename.slice(0, lastDot) : basename
}

/** Same as {@link filePathToDisplayName} but keeps the extension (e.g. "track.mp3"). */
export function filePathToBasename(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath
}
