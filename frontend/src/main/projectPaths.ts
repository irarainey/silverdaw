import { extname, isAbsolute, resolve as pathResolve } from 'node:path'

// Project files carry this extension; the project-open IPC handlers accept only
// renderer-provided paths that resolve to an absolute `.silverdaw` file.
export const PROJECT_FILE_EXTENSION = 'silverdaw'

// Validate and canonicalise a renderer-provided project path before any
// filesystem access. Returns the canonical absolute path, or null when the
// input is not a string, is not absolute, or is not a `.silverdaw` file.
// `path.resolve` collapses any `..`/`.` traversal segments, and the extension
// is re-checked on the canonical form as defence in depth (mirrors the audio
// allow-list in `audioPaths.ts`).
export function canonicaliseProjectPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (!isAbsolute(value)) return null
  const canonical = pathResolve(value)
  if (extname(canonical).replace(/^\./, '').toLowerCase() !== PROJECT_FILE_EXTENSION) return null
  return canonical
}
