import { basename, dirname, extname, isAbsolute, join, resolve as pathResolve } from 'node:path'

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

// A project is a portable folder: `<chosen dir>/<ProjectName>/<ProjectName>.silverdaw`.
// Given the path the user picked in the Save dialog, nest it inside a folder named
// after the project so all generated artifacts (Stems/, Peaks/, Samples/) live
// alongside the project file and travel together. If the user already chose a
// same-named folder, the path is returned unchanged to avoid double-nesting.
// Pure path computation — the caller is responsible for creating the directory.
export function projectFolderPath(chosenPath: string): string {
  const ext = extname(chosenPath) || `.${PROJECT_FILE_EXTENSION}`
  const name = basename(chosenPath, ext)
  if (name.length === 0) return chosenPath
  const parent = dirname(chosenPath)
  if (basename(parent).toLowerCase() === name.toLowerCase()) return chosenPath
  return join(parent, name, `${name}${ext}`)
}
