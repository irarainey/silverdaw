// Background autosave writer: ticks while enabled, dirty, and assigned a projectId.
// Writes pending/confirmed manifests so crash recovery can ignore partial saves.
// Startup recovery reads buckets elsewhere; this module owns writes and cleanup.

import type { Pinia } from 'pinia'
import { watch, type WatchStopHandle } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useAppStore } from '@/stores/appStore'
import { log } from '@/lib/log'

let started = false
let timerId: ReturnType<typeof setInterval> | null = null
let stopWatchers: Array<WatchStopHandle> = []
let pinia: Pinia | null = null

/** Minimum tick interval, even if preferences bypass main's clamp. */
const MIN_TICK_MS = 5000

function clearTimer(): void {
  if (timerId !== null) {
    clearInterval(timerId)
    timerId = null
  }
}

async function performTick(): Promise<void> {
  if (!pinia) return
  const project = useProjectStore(pinia)
  // Recovery makes renderer/engine identity transient; never write then.
  if (project.recoveryInFlight) {
    log.debug('autosave', 'tick skipped — engine recovery in flight')
    return
  }
  if (!project.isDirty) return
  const projectId = project.projectId
  if (!projectId) return

  // Main owns autosave paths so the renderer cannot escape the bucket root.
  const dirInfo = await window.silverdaw.resolveAutosaveDir(projectId)
  if (!dirInfo) {
    log.warn('autosave', `resolveAutosaveDir failed for ${projectId}`)
    return
  }

  // Mark pending before saving so recovery skips partial writes.
  const originalPath = project.currentFilePath
  const projectName = project.projectName
  const startedIso = new Date().toISOString()
  const manifestOk = await window.silverdaw.writeAutosaveManifest({
    projectId,
    originalPath,
    projectName,
    savedAtIso: startedIso,
    pending: true
  })
  if (!manifestOk) {
    log.warn('autosave', `writeAutosaveManifest(pending) failed for ${projectId}`)
    return
  }

  // `autosaveAndWait` resolves on PROJECT_AUTOSAVED.
  const result = await project.autosaveAndWait(dirInfo.filePath)
  if (!result.ok) {
    log.warn('autosave', `PROJECT_AUTOSAVE failed: ${result.error ?? 'unknown'}`)
    return
  }

  // Confirm only if the same project still owns the bucket.
  if (project.projectId !== projectId) {
    log.debug('autosave', `discarding manifest update for replaced project ${projectId}`)
    return
  }
  await window.silverdaw.writeAutosaveManifest({
    projectId,
    originalPath,
    projectName,
    savedAtIso: new Date().toISOString(),
    pending: false
  })
  log.debug('autosave', `tick ok project=${projectId} path=${dirInfo.filePath}`)
}

function restartTimer(): void {
  clearTimer()
  if (!pinia) return
  const app = useAppStore(pinia)
  const project = useProjectStore(pinia)
  if (!app.autosaveEnabled) return
  if (!project.isDirty) return
  if (!project.projectId) return
  const intervalMs = Math.max(MIN_TICK_MS, app.autosaveIntervalSeconds * 1000)
  // Tick immediately so newly dirty projects get a prompt first snapshot.
  void performTick()
  timerId = setInterval(() => {
    void performTick()
  }, intervalMs)
  log.debug('autosave', `started timer intervalMs=${intervalMs}`)
}

/** Start the autosave manager; subsequent calls are no-ops. */
export function startAutosaveManager(piniaInstance: Pinia): void {
  if (started) return
  started = true
  pinia = piniaInstance
  const project = useProjectStore(pinia)
  const app = useAppStore(pinia)

  // These inputs independently determine whether the timer runs.
  stopWatchers.push(
    watch(
      () => [project.isDirty, project.projectId, app.autosaveEnabled, app.autosaveIntervalSeconds],
      restartTimer,
      { immediate: true }
    )
  )

  // Clean up the previous project bucket after safe project transitions.
  stopWatchers.push(
    watch(
      () => project.previousProjectId,
      (oldId) => {
        if (!oldId) return
        if (oldId === project.projectId) return
        // Recovery preserves all buckets; the empty reconnect can rotate ids.
        if (project.recoveryInFlight) {
          project.previousProjectId = null
          return
        }
        void window.silverdaw.clearAutosave(oldId).then((ok) => {
          if (ok) log.debug('autosave', `cleared previous bucket ${oldId}`)
        })
        project.previousProjectId = null
      }
    )
  )
}

/** Delete the autosave bucket after a successful explicit save. */
export async function clearAutosaveBucket(projectId: string | null): Promise<void> {
  if (!projectId) return
  await window.silverdaw.clearAutosave(projectId)
}

/** Tear down the autosave manager. */
export function stopAutosaveManager(): void {
  clearTimer()
  for (const stop of stopWatchers) stop()
  stopWatchers = []
  started = false
  pinia = null
}
