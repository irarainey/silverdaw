import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { ProjectImportSource } from '../shared/types'
import { PROJECT_FILE_EXTENSION } from './projectPaths'

function isProjectFile(fileName: string): boolean {
  return extname(fileName).slice(1).toLowerCase() === PROJECT_FILE_EXTENSION
}

function fallbackProjectName(filePath: string): string {
  return basename(filePath, extname(filePath))
}

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
    return name || fallbackProjectName(filePath)
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
