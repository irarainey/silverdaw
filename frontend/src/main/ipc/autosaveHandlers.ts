// Autosave filesystem IPC handlers: resolve bucket dir, write manifest, list
// recoverable projects, and clear a bucket. Access is confined to validated
// project buckets under the autosave root. Registered from main/index.ts.

import { app, ipcMain } from 'electron'
import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises'
import { join, resolve as pathResolve } from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import {
  AUTOSAVE_FILENAME,
  AUTOSAVE_ID_REGEX,
  AUTOSAVE_MANIFEST_FILENAME,
  getAutosaveRoot,
  isAutosaveManifest,
  resolveAutosaveDir,
  type AutosaveManifest
} from '../autosaveStore'
import { logMain } from '../log'

export function registerAutosaveHandlers(): void {
  // ─── Autosave folder + manifest IPCs ────────────────────────────────────
  // Main confines autosave filesystem access to validated project buckets.

  ipcMain.handle(
    IPC.autosave.resolveDir,
    async (_evt, projectId: unknown): Promise<{ dir: string; filePath: string } | null> => {
      if (typeof projectId !== 'string') return null
      try {
        const dir = resolveAutosaveDir(projectId)
        await mkdir(dir, { recursive: true })
        return { dir, filePath: join(dir, AUTOSAVE_FILENAME) }
      } catch (err) {
        logMain('WARN ', 'autosave:resolveDir', 'failed:', err)
        return null
      }
    }
  )

  ipcMain.handle(IPC.autosave.writeManifest, async (_evt, payload: unknown): Promise<boolean> => {
    if (!payload || typeof payload !== 'object') return false
    const p = payload as Partial<AutosaveManifest>
    if (typeof p.projectId !== 'string' || !AUTOSAVE_ID_REGEX.test(p.projectId)) return false
    const manifest: AutosaveManifest = {
      projectId: p.projectId,
      originalPath: typeof p.originalPath === 'string' && p.originalPath.length > 0 ? p.originalPath : null,
      projectName: typeof p.projectName === 'string' ? p.projectName : 'Untitled',
      savedAtIso: typeof p.savedAtIso === 'string' ? p.savedAtIso : new Date().toISOString(),
      pending: typeof p.pending === 'boolean' ? p.pending : false,
      appVersion: app.getVersion()
    }
    try {
      const dir = resolveAutosaveDir(manifest.projectId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, AUTOSAVE_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8')
      return true
    } catch (err) {
      logMain('WARN ', 'autosave:writeManifest', 'failed:', err)
      return false
    }
  })

  ipcMain.handle(IPC.autosave.listRecoverable, async (): Promise<
    Array<{
      projectId: string
      originalPath: string | null
      projectName: string
      autosavePath: string
      savedAtIso: string
      originalExists: boolean
    }>
  > => {
    const root = getAutosaveRoot()
    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      return []
    }
    const out: Array<{
      projectId: string
      originalPath: string | null
      projectName: string
      autosavePath: string
      savedAtIso: string
      originalExists: boolean
    }> = []
    for (const projectId of entries) {
      if (!AUTOSAVE_ID_REGEX.test(projectId)) continue
      const dir = join(root, projectId)
      const manifestPath = join(dir, AUTOSAVE_MANIFEST_FILENAME)
      const autosavePath = join(dir, AUTOSAVE_FILENAME)
      let manifest: AutosaveManifest | null = null
      try {
        const raw = await readFile(manifestPath, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (isAutosaveManifest(parsed)) manifest = parsed
      } catch {
        manifest = null
      }
      if (!manifest) continue
      if (manifest.pending) continue
      let autosaveStat: Awaited<ReturnType<typeof stat>> | null = null
      try {
        autosaveStat = await stat(autosavePath)
      } catch {
        continue
      }
      // Recoverable iff autosave is newer or the backing file is missing.
      let originalExists = false
      let recoverable = manifest.originalPath === null
      if (manifest.originalPath) {
        try {
          const origStat = await stat(manifest.originalPath)
          originalExists = true
          if (autosaveStat.mtimeMs > origStat.mtimeMs + 500) recoverable = true
        } catch {
          recoverable = true
        }
      }
      if (!recoverable) continue
      out.push({
        projectId: manifest.projectId,
        originalPath: manifest.originalPath,
        projectName: manifest.projectName,
        autosavePath,
        savedAtIso: manifest.savedAtIso,
        originalExists
      })
    }
    out.sort((a, b) => (a.savedAtIso < b.savedAtIso ? 1 : -1))
    return out
  })

  ipcMain.handle(IPC.autosave.clear, async (_evt, projectId: unknown): Promise<boolean> => {
    if (typeof projectId !== 'string' || !AUTOSAVE_ID_REGEX.test(projectId)) return false
    try {
      const dir = resolveAutosaveDir(projectId)
      // Paranoid root check in addition to projectId validation.
      const root = getAutosaveRoot()
      const canonical = pathResolve(dir)
      const canonicalRoot = pathResolve(root)
      if (!canonical.toLowerCase().startsWith(canonicalRoot.toLowerCase())) {
        logMain('WARN ', 'autosave:clear', 'refused traversal:', canonical)
        return false
      }
      await rm(canonical, { recursive: true, force: true })
      return true
    } catch (err) {
      logMain('WARN ', 'autosave:clear', 'failed:', err)
      return false
    }
  })
}
