// Pure helpers for turning a project file path into user-facing text. Shared by
// the File-menu Recent Projects submenu and the StartupScreen recents list so
// both display project names identically.

/** Final path segment of a Windows or POSIX path. */
export function basename(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return lastSep >= 0 ? path.slice(lastSep + 1) : path
}

/** The user-facing project name: the file name without the `.silverdaw`
 *  extension (a project saves as `<ProjectName>/<ProjectName>.silverdaw`). */
export function projectNameFromPath(path: string): string {
  return basename(path).replace(/\.silverdaw$/i, '')
}

export function projectRootFromPath(projectFile: string | null): string {
  if (!projectFile) return ''
  const path = projectFile.replaceAll('/', '\\')
  const root = path.slice(0, path.lastIndexOf('\\') + 1)
  return /^[A-Z]:\\$/i.test(root) ? root : root.replace(/\\$/, '')
}

/** Project-owned files use a short path; external sources keep their full location. */
export function reportFilePath(path: string, projectRoot: string): string {
  if (!projectRoot) return path
  const prefix = projectRoot.replace(/\\$/, '') + '\\'
  const normalized = path.replaceAll('/', '\\')
  if (!normalized.toLowerCase().startsWith(prefix.toLowerCase()) || normalized.split('\\').includes('..')) return path
  return '\\' + normalized.slice(prefix.length)
}
