import { app } from 'electron'
import { join } from 'node:path'

// Project IDs are strictly whitelisted before touching the autosave filesystem.
export const AUTOSAVE_FILENAME = 'autosave.silverdaw'
export const AUTOSAVE_MANIFEST_FILENAME = 'manifest.json'
export const AUTOSAVE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/

export function getAutosaveRoot(): string {
  return join(app.getPath('userData'), 'autosave')
}

export function resolveAutosaveDir(projectId: string): string {
  if (!AUTOSAVE_ID_REGEX.test(projectId)) {
    throw new Error(`[autosave] rejected projectId ${JSON.stringify(projectId)}`)
  }
  return join(getAutosaveRoot(), projectId)
}

export interface AutosaveManifest {
  projectId: string
  originalPath: string | null
  projectName: string
  savedAtIso: string
  /** Recovery skips pending entries because the file may be partial. */
  pending: boolean
  appVersion: string
}

export function isAutosaveManifest(value: unknown): value is AutosaveManifest {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.projectId === 'string' &&
    AUTOSAVE_ID_REGEX.test(v.projectId) &&
    (v.originalPath === null || typeof v.originalPath === 'string') &&
    typeof v.projectName === 'string' &&
    typeof v.savedAtIso === 'string' &&
    typeof v.pending === 'boolean'
  )
}
