// Mid-session engine recovery: reconnect, reload the captured project, and gate the UI.
// Each cycle carries a `recoveryGeneration` so stale async reconnects cannot win.
// Called by `bridgeService`; engine commands flow through stores to keep dependencies one-way.

import { useTransportStore } from '@/stores/transportStore'
import { useProjectStore } from '@/stores/projectStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { abandonActiveStemSeparation } from '@/lib/stems/stemSeparationFlow'
import { log } from '@/lib/log'
import type { ProjectStatePayload } from '@shared/bridge-protocol'

interface RecoveryTarget {
  projectId: string | null
  currentFilePath: string | null
  projectName: string
  wasDirty: boolean
  generation: number
}

const RESTORE_TIMEOUT_MS = 20_000
/** Max wait for a respawned engine to reconnect and send its first snapshot. */
const RECONNECT_TIMEOUT_MS = 15_000

let recoveryGeneration = 0
let target: RecoveryTarget | null = null
let restoreTimer: ReturnType<typeof setTimeout> | null = null
// Expected restore path; `null` means the target is untitled.
let expectedRestorePath: string | null = null

function clearRestoreTimer(): void {
  if (restoreTimer) {
    clearTimeout(restoreTimer)
    restoreTimer = null
  }
}

/** Arm the current recovery phase deadline so the overlay cannot spin forever. */
function armRecoveryDeadline(generation: number, ms: number): void {
  clearRestoreTimer()
  restoreTimer = setTimeout(() => {
    restoreTimer = null
    if (generation !== recoveryGeneration) return
    const phase = useTransportStore().engineRecovery
    if (phase === 'recovering' || phase === 'restoring') {
      log.error('recovery', `phase '${phase}' timed out after ${ms}ms`)
      markUnavailable()
    }
  }, ms)
}

function beginCycle(): void {
  const project = useProjectStore()
  const transport = useTransportStore()
  recoveryGeneration += 1
  target = {
    projectId: project.projectId,
    currentFilePath: project.currentFilePath,
    projectName: project.projectName,
    wasDirty: project.isDirty,
    generation: recoveryGeneration
  }
  project.recoveryInFlight = true
  transport.setEngineRecovery('recovering')
  armRecoveryDeadline(recoveryGeneration, RECONNECT_TIMEOUT_MS)
  // A crash mid-separation (e.g. a GPU driver reset) kills the backend before it
  // can report STEM_FAILED, so fail the active job here rather than let it vanish.
  abandonActiveStemSeparation(
    'Stem separation was interrupted because the audio engine restarted. Please try again.'
  )
  log.warn(
    'recovery',
    `cycle ${recoveryGeneration} opened — captured projectId=${target.projectId ?? 'null'} ` +
      `path=${target.currentFilePath ?? 'null'} dirty=${target.wasDirty}`
  )
}

/** Re-arm an open cycle after another crash, keeping the original target. */
function rearmCycle(): void {
  recoveryGeneration += 1
  if (target) target.generation = recoveryGeneration
  expectedRestorePath = null
  useTransportStore().setEngineRecovery('recovering')
  armRecoveryDeadline(recoveryGeneration, RECONNECT_TIMEOUT_MS)
  log.warn('recovery', `cycle re-armed as ${recoveryGeneration}`)
}

export function onConnectionLost(): void {
  const transport = useTransportStore()
  // Cold-start failures belong to the startup path.
  if (!transport.hasBeenReady) return
  if (transport.engineRecovery === 'ok') {
    beginCycle()
  } else {
    rearmCycle()
  }
}

/** Watchdog found a hung engine; capture state, then force restart. */
export function onEngineUnresponsive(reason: string): void {
  const transport = useTransportStore()
  if (!transport.hasBeenReady) return
  if (transport.engineRecovery === 'ok') {
    beginCycle()
  }
  log.error('recovery', `engine unresponsive — requesting restart (${reason})`)
  void window.silverdaw.restartBackend(reason)
}

/** Process status is advisory except `failed`; restoration completes on snapshots. */
export function onBackendStatus(status: 'restarting' | 'recovered' | 'failed'): void {
  const transport = useTransportStore()
  if (status === 'failed') {
    // Cold-start supervisor failures belong to the StartupScreen path.
    if (transport.hasBeenReady || transport.engineRecovery !== 'ok') {
      markUnavailable()
    }
    return
  }
  if (status === 'restarting') {
    if (!transport.hasBeenReady) return
    if (transport.engineRecovery === 'ok') beginCycle()
    return
  }
  // 'recovered' is advisory; completion is snapshot-driven.
}

/** Classify recovery PROJECT_STATE snapshots: empty reconnect or restored reset. */
export function onProjectStateApplied(snapshot: ProjectStatePayload): void {
  const transport = useTransportStore()
  if (transport.engineRecovery === 'recovering') {
    void kickRestore(recoveryGeneration)
  } else if (transport.engineRecovery === 'restoring' && snapshot.reset === true) {
    // Path mismatch is diagnostic; completing beats stalling on benign normalisation.
    if (expectedRestorePath !== null && snapshot.filePath !== expectedRestorePath) {
      log.warn(
        'recovery',
        `restore snapshot path '${snapshot.filePath ?? 'null'}' != expected ` +
          `'${expectedRestorePath}' — completing anyway`
      )
    }
    completeRecovery(true)
  }
}

async function kickRestore(generation: number): Promise<void> {
  const transport = useTransportStore()
  const project = useProjectStore()
  transport.setEngineRecovery('restoring')
  armRecoveryDeadline(generation, RESTORE_TIMEOUT_MS)

  const captured = target
  if (!captured || captured.generation !== generation) return

  let entries: Awaited<ReturnType<typeof window.silverdaw.listRecoverableAutosaves>> = []
  try {
    entries = await window.silverdaw.listRecoverableAutosaves()
  } catch (err) {
    log.warn('recovery', `listRecoverableAutosaves failed: ${String(err)}`)
  }
  if (generation !== recoveryGeneration) return

  const entry = captured.projectId
    ? entries.find((e) => e.projectId === captured.projectId)
    : undefined

  if (entry) {
    log.info('recovery', `restoring from autosave bucket ${entry.projectId}`)
    expectedRestorePath = entry.originalPath ?? captured.currentFilePath
    const res = await project.requestLoadRecovery(
      entry.autosavePath,
      entry.originalPath ?? captured.currentFilePath,
      captured.projectId ?? undefined
    )
    if (generation !== recoveryGeneration) return
    if (!res.ok) {
      log.error('recovery', `recovery load failed: ${res.error ?? 'unknown'}`)
      markUnavailable()
    }
    return
  }

  if (captured.currentFilePath) {
    // Preserve the original projectId so future autosaves use the same bucket.
    log.info('recovery', `no autosave; restoring from file ${captured.currentFilePath}`)
    expectedRestorePath = captured.currentFilePath
    if (captured.projectId) project.pendingRecoveredProjectId = captured.projectId
    project.requestLoad(captured.currentFilePath)
    return
  }

  // Untitled project with no autosave already matches the empty engine.
  log.info('recovery', 'nothing to restore (untitled, no autosave)')
  completeRecovery(false)
}

function completeRecovery(restored: boolean): void {
  clearRestoreTimer()
  const transport = useTransportStore()
  const project = useProjectStore()
  project.recoveryInFlight = false
  target = null
  expectedRestorePath = null
  transport.setEngineRecovery('ok')
  log.info('recovery', `complete (restored=${restored})`)
  if (restored) {
    useNotificationsStore().pushInfo(
      'Reconnected to the audio engine. Any changes from the last few seconds may need redoing.',
      8000
    )
  }
}

function markUnavailable(): void {
  clearRestoreTimer()
  useTransportStore().setEngineRecovery('unavailable')
  // Keep autosave suppressed until retry or quit.
  log.error('recovery', 'engine unavailable — awaiting user action')
}

export function retryRecovery(): void {
  log.info('recovery', 'user requested retry')
  rearmCycle()
  void window.silverdaw.restartBackend('user retry')
}

export function resetEngineRecovery(): void {
  clearRestoreTimer()
  recoveryGeneration = 0
  target = null
  expectedRestorePath = null
}
