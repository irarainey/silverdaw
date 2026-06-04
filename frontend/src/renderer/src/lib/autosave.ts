// Background autosave manager.
//
// Runs a setInterval whose tick fires a PROJECT_AUTOSAVE over the
// bridge, writes a manifest into `%APPDATA%/Silverdaw/autosave/<id>/`,
// and lets the renderer recover the project on a subsequent launch.
//
// Lifecycle:
//   - `start(pinia)` — subscribe to `projectStore.isDirty` and the
//     persisted autosave config. While dirty AND enabled AND the
//     project has a known `projectId`, the tick runs. Stops the tick
//     the moment any of those conditions become false.
//   - `stop()` — tear down on app unmount (defensive — Silverdaw is a
//     single-window single-shot app, but this lets dev HMR cleanly
//     swap out the module).
//   - `clearBucket(projectId)` — exposed for the bridge's
//     PROJECT_SAVED handler so a successful explicit save deletes the
//     now-redundant autosave artefacts.
//
// Crash-recovery is driven from `App.vue`'s startup coordinator (it
// calls `window.silverdaw.listRecoverableAutosaves` directly); this
// module only owns the *write* side.

import type { Pinia } from 'pinia'
import { watch, type WatchStopHandle } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useAppStore } from '@/stores/appStore'
import { log } from '@/lib/log'

let started = false
let timerId: ReturnType<typeof setInterval> | null = null
let stopWatchers: Array<WatchStopHandle> = []
let pinia: Pinia | null = null

/** Configurable safety margin: never tick faster than this even if a
 *  hostile preference write somehow slipped past main's clamp. */
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
  // Never autosave while a mid-session engine recovery is in flight —
  // the renderer's identity (projectId / currentFilePath / dirty) is
  // transiently inconsistent with the engine, so a write here could
  // clobber the very autosave we're restoring from.
  if (project.recoveryInFlight) {
    log.debug('autosave', 'tick skipped — engine recovery in flight')
    return
  }
  if (!project.isDirty) return
  const projectId = project.projectId
  if (!projectId) return

  // 1. Resolve the autosave folder + filePath via main. Main owns the
  //    path so we never let a buggy/malicious renderer compute paths
  //    outside the autosave root.
  const dirInfo = await window.silverdaw.resolveAutosaveDir(projectId)
  if (!dirInfo) {
    log.warn('autosave', `resolveAutosaveDir failed for ${projectId}`)
    return
  }

  // 2. Write a `pending=true` manifest BEFORE asking the backend to
  //    save. If we crash mid-write the recovery scanner will skip the
  //    entry (it filters out `pending=true`), so a partial file never
  //    surfaces to the user.
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

  // 3. Ask the backend to serialise the current ValueTree to the
  //    autosave file. `autosaveAndWait` resolves on PROJECT_AUTOSAVED.
  const result = await project.autosaveAndWait(dirInfo.filePath)
  if (!result.ok) {
    log.warn('autosave', `PROJECT_AUTOSAVE failed: ${result.error ?? 'unknown'}`)
    return
  }

  // 4. Mark the manifest as confirmed. If the project has been
  //    replaced in the meantime (Load / New), don't touch the manifest
  //    — the new owner will manage it.
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
  // Fire one tick immediately, then on the interval. Mirrors the
  // user's mental model of "save the moment something changes": a
  // dirty project not yet autosaved gets its first snapshot quickly,
  // not after a full interval has elapsed.
  void performTick()
  timerId = setInterval(() => {
    void performTick()
  }, intervalMs)
  log.debug('autosave', `started timer intervalMs=${intervalMs}`)
}

/** Start the autosave manager. Idempotent — `start` calls after the
 *  first are no-ops. */
export function startAutosaveManager(piniaInstance: Pinia): void {
  if (started) return
  started = true
  pinia = piniaInstance
  const project = useProjectStore(pinia)
  const app = useAppStore(pinia)

  // Re-evaluate whenever any of (isDirty, projectId, autosaveEnabled,
  // intervalSeconds) changes. Each of these can independently flip
  // the active/inactive state of the timer.
  stopWatchers.push(
    watch(
      () => [project.isDirty, project.projectId, app.autosaveEnabled, app.autosaveIntervalSeconds],
      restartTimer,
      { immediate: true }
    )
  )

  // Bucket cleanup on transitions. After a `reset=true` snapshot the
  // store stashes the previous id in `previousProjectId`; we delete
  // its autosave folder once a non-dirty snapshot has been applied so
  // the user never sees stale autosaves for projects they've already
  // moved past.
  stopWatchers.push(
    watch(
      () => project.previousProjectId,
      (oldId) => {
        if (!oldId) return
        if (oldId === project.projectId) return
        // During recovery we deliberately preserve every bucket — the
        // empty reconnect snapshot rotates the id, and deleting here would
        // destroy the autosave we're about to restore. Just clear the
        // marker; a normal transition later will clean up safely.
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

/** Delete the autosave bucket for `projectId`. Used by the bridge's
 *  PROJECT_SAVED handler after a successful explicit save. */
export async function clearAutosaveBucket(projectId: string | null): Promise<void> {
  if (!projectId) return
  await window.silverdaw.clearAutosave(projectId)
}

/** Tear down the autosave manager. Used by `App.vue`'s
 *  `onBeforeUnmount`; in production this matches the app's lifetime. */
export function stopAutosaveManager(): void {
  clearTimer()
  for (const stop of stopWatchers) stop()
  stopWatchers = []
  started = false
  pinia = null
}
