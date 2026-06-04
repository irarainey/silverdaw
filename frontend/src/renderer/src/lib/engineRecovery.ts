// Mid-session audio-engine recovery coordinator.
//
// The audio engine runs as a separate process. When it dies (crash, OS
// sleep/resume fault) or hangs, Electron's main supervisor respawns it on
// the SAME bridge port + token, so the renderer's WebSocket reconnects
// transparently. But a respawned engine is EMPTY: "reconnected" is not the
// same as "recovered". This module drives the gap — capturing what the
// user had open at the moment of loss, then re-loading it into the fresh
// engine — and exposes a small state machine (`transportStore.engineRecovery`)
// that gates the UI via `EngineRecoveryOverlay`.
//
// Threading model is single-threaded (renderer), but async reconnects +
// rapid crash loops can interleave. Every cycle is tagged with a monotonic
// `recoveryGeneration`; async continuations and timeouts check it and bail
// if a newer cycle has superseded them. This prevents a stale autosave
// lookup or load completion from corrupting a fresh recovery.
//
// `bridgeService` calls the `on*` hooks; this module never imports
// `bridgeService` (it drives the engine through `projectStore` actions),
// keeping the dependency one-directional.

import { useTransportStore } from '@/stores/transportStore'
import { useProjectStore } from '@/stores/projectStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { ProjectStatePayload } from '@shared/bridge-protocol'

/** What the user had open at the instant the engine was lost. */
interface RecoveryTarget {
  projectId: string | null
  currentFilePath: string | null
  projectName: string
  wasDirty: boolean
  generation: number
}

/** Max time to wait for the re-load to land before declaring failure. */
const RESTORE_TIMEOUT_MS = 20_000
/**
 * Max time to wait for the respawned engine to reconnect and deliver its
 * first snapshot before declaring failure. Guards the 'recovering' phase so
 * a restart that never produces a reconnect (failed spawn, no socket close,
 * hung supervisor) can't leave the overlay spinning with no way out.
 */
const RECONNECT_TIMEOUT_MS = 15_000

let recoveryGeneration = 0
let target: RecoveryTarget | null = null
let restoreTimer: ReturnType<typeof setTimeout> | null = null
/**
 * File path the in-flight restore is expected to land on. Used to correlate
 * the completing `reset=true` snapshot with THIS recovery, so an unrelated
 * reset snapshot can't prematurely mark recovery complete. `null` means the
 * restore target is an untitled project (no file).
 */
let expectedRestorePath: string | null = null

function clearRestoreTimer(): void {
  if (restoreTimer) {
    clearTimeout(restoreTimer)
    restoreTimer = null
  }
}

/**
 * Arm the recovery deadline for the current phase. A single timer covers
 * both the reconnect wait ('recovering') and the re-load wait ('restoring')
 * — whichever phase is active when it fires, an unfinished recovery becomes
 * terminal so the overlay always offers Try Again / Quit instead of
 * spinning forever.
 */
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

/** Capture the current project as the recovery target and open a cycle. */
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
  log.warn(
    'recovery',
    `cycle ${recoveryGeneration} opened — captured projectId=${target.projectId ?? 'null'} ` +
      `path=${target.currentFilePath ?? 'null'} dirty=${target.wasDirty}`
  )
}

/**
 * Re-arm an already-open cycle for a fresh reconnect attempt (e.g. the
 * engine crashed again mid-restore). Bumps the generation so any stale
 * async from the previous attempt is ignored, and resets to 'recovering'
 * so the next empty snapshot re-kicks the re-load. Keeps the original
 * captured target.
 */
function rearmCycle(): void {
  recoveryGeneration += 1
  if (target) target.generation = recoveryGeneration
  expectedRestorePath = null
  useTransportStore().setEngineRecovery('recovering')
  armRecoveryDeadline(recoveryGeneration, RECONNECT_TIMEOUT_MS)
  log.warn('recovery', `cycle re-armed as ${recoveryGeneration}`)
}

/** WebSocket dropped mid-session (only called for unexpected closes). */
export function onConnectionLost(): void {
  const transport = useTransportStore()
  // Cold-start connection failures are handled by the startup path, not
  // here — only engage once the engine has been ready at least once.
  if (!transport.hasBeenReady) return
  if (transport.engineRecovery === 'ok') {
    beginCycle()
  } else {
    rearmCycle()
  }
}

/**
 * The liveness watchdog declared the engine hung (socket open, no PONG).
 * Capture state while the engine still has the project, then ask main to
 * force-restart it; the ensuing socket close flows through the normal
 * reconnect path.
 */
export function onEngineUnresponsive(reason: string): void {
  const transport = useTransportStore()
  if (!transport.hasBeenReady) return
  if (transport.engineRecovery === 'ok') {
    beginCycle()
  }
  log.error('recovery', `engine unresponsive — requesting restart (${reason})`)
  void window.silverdaw.restartBackend(reason)
}

/**
 * Process-level status pushed from main's supervisor. `restarting` lets
 * us show the overlay even before the socket closes (the hang case);
 * `failed` is terminal; `recovered` is advisory only — actual restoration
 * is confirmed by the re-load's snapshot, never by process status alone.
 */
export function onBackendStatus(status: 'restarting' | 'recovered' | 'failed'): void {
  const transport = useTransportStore()
  if (status === 'failed') {
    // Only own the terminal state for a MID-SESSION failure. A cold-start
    // supervisor failure (engine never became ready) belongs to the
    // StartupScreen path, not this overlay.
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
  // 'recovered': advisory; completion is driven by the re-load snapshot.
}

/**
 * Called from the PROJECT_STATE dispatch arm after the snapshot has been
 * applied to the store. Decides whether this snapshot is the empty
 * reconnect snapshot (→ kick the re-load) or the re-load's own
 * `reset=true` snapshot (→ recovery complete).
 */
export function onProjectStateApplied(snapshot: ProjectStatePayload): void {
  const transport = useTransportStore()
  if (transport.engineRecovery === 'recovering') {
    // First snapshot after reconnecting to the fresh, empty engine.
    void kickRestore(recoveryGeneration)
  } else if (transport.engineRecovery === 'restoring' && snapshot.reset === true) {
    // Diagnostic only: the UI is fully input-gated during recovery, so the
    // sole source of a reset snapshot here is our own re-load. If the path
    // ever fails to line up with what we asked to restore, log it — but
    // still complete, since stalling to the deadline would be worse than a
    // benign path-normalisation difference.
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

/** Re-load the captured project into the freshly respawned engine. */
async function kickRestore(generation: number): Promise<void> {
  const transport = useTransportStore()
  const project = useProjectStore()
  transport.setEngineRecovery('restoring')
  // Extend the deadline for the (potentially slower) re-load phase.
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
    // Success completes via the reset=true snapshot in onProjectStateApplied.
    if (!res.ok) {
      log.error('recovery', `recovery load failed: ${res.error ?? 'unknown'}`)
      markUnavailable()
    }
    return
  }

  if (captured.currentFilePath) {
    // No autosave bucket — re-load the last saved file. Seed
    // pendingRecoveredProjectId so the re-load adopts the SAME projectId
    // and future autosaves keep writing to the original bucket.
    log.info('recovery', `no autosave; restoring from file ${captured.currentFilePath}`)
    expectedRestorePath = captured.currentFilePath
    if (captured.projectId) project.pendingRecoveredProjectId = captured.projectId
    project.requestLoad(captured.currentFilePath)
    // Completion via the reset=true snapshot.
    return
  }

  // Nothing to restore (untitled project, never autosaved). The empty
  // engine already matches an empty project; finish without a toast.
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
  // recoveryInFlight stays true: the engine isn't usable, and we must
  // keep suppressing autosave until the user retries or quits.
  log.error('recovery', 'engine unavailable — awaiting user action')
}

/** User clicked "Try again" on the terminal overlay. */
export function retryRecovery(): void {
  log.info('recovery', 'user requested retry')
  rearmCycle()
  void window.silverdaw.restartBackend('user retry')
}

/** Reset module state (used by tests / teardown). */
export function resetEngineRecovery(): void {
  clearRestoreTimer()
  recoveryGeneration = 0
  target = null
  expectedRestorePath = null
}
