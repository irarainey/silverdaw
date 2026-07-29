import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { ProjectImportSource } from '../shared/types'
import { PROJECT_FILE_EXTENSION } from './projectPaths'

function isProjectFile(fileName: string): boolean {
  return extname(fileName).slice(1).toLowerCase() === PROJECT_FILE_EXTENSION
}

/**
 * The name every project carries until it is explicitly named. Releases before
 * 1.4.2 adopted the chosen filename *after* serialising, so every project saved
 * by them stores this literal — which is why an empty-string check is not enough
 * to spot "this project has no meaningful name of its own".
 */
const DEFAULT_PROJECT_NAME = 'Untitled'

function fallbackProjectName(filePath: string): string {
  return basename(filePath, extname(filePath))
}

/**
 * Best display name for a project, for a read-only picker.
 *
 * Falling back to the filename when the stored name is the default matters here:
 * without it every pre-1.4.2 project renders as an identical "Untitled" row and
 * the list becomes unusable. This is deliberately a *display* fallback only —
 * nothing is written back. Substituting the name into loaded project state would
 * be a different and unsafe change, because the next save or autosave would then
 * persist a name the user never chose.
 */
async function readProjectName(filePath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      name?: unknown
      project?: { name?: unknown }
    }
    const name = typeof parsed.project?.name === 'string'
      ? parsed.project.name.trim()
      : typeof parsed.name === 'string'
        ? parsed.name.trim()
        : ''
    return name && name !== DEFAULT_PROJECT_NAME ? name : fallbackProjectName(filePath)
  } catch {
    return fallbackProjectName(filePath)
  }
}

/** Lists the standard direct-file and one-project-folder layouts under the configured projects root. */
export async function listProjectImportSources(projectsRoot: string): Promise<ProjectImportSource[]> {
  if (!projectsRoot) return []

  const root = resolve(projectsRoot)
  let rootEntries: Dirent<string>[]
  try {
    rootEntries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const paths = new Set<string>()
  for (const entry of rootEntries) {
    if (entry.isFile() && isProjectFile(entry.name)) {
      paths.add(resolve(root, entry.name))
      continue
    }
    if (!entry.isDirectory()) continue

    try {
      const children = await readdir(join(root, entry.name), { withFileTypes: true })
      for (const child of children) {
        if (child.isFile() && isProjectFile(child.name)) {
          paths.add(resolve(root, entry.name, child.name))
        }
      }
    } catch {
      // A project directory becoming unavailable must not prevent listing its siblings.
    }
  }

  const sources = await Promise.all(
    [...paths].map(async (path) => ({ path, name: await readProjectName(path) }))
  )
  return sources.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}
