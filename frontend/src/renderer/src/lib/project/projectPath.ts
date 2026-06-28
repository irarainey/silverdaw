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
