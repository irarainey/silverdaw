// Undo/redo in-flight tracking for the busy cursor.
//
// An undo is a request/response round trip: the renderer sends EDIT_UNDO and the
// backend answers with a soft-replace PROJECT_STATE. A structural undo (e.g. undoing
// a chop that produced 100+ clips) takes long enough that the UI looks frozen with no
// feedback, so a flag is raised for the duration and drives the busy cursor.
//
// Lives in its own module because both `projectStore` (raise) and `projectSnapshot`
// (clear) need it, and importing the store from the snapshot module would be circular.

import { log } from '@/lib/log'
import type { ProjectState } from './projectTypes'

/**
 * Safety net for the busy cursor. The backend broadcasts nothing when a transaction
 * turns out to be a no-op, and a dropped bridge response would otherwise strand the
 * cursor forever. Generous enough not to clear early on a large structural undo.
 */
const UNDO_PENDING_TIMEOUT_MS = 10_000

let watchdog: ReturnType<typeof setTimeout> | null = null

function stopWatchdog(): void {
  if (watchdog === null) return
  clearTimeout(watchdog)
  watchdog = null
}

/** Marks an undo/redo as in flight and arms the watchdog. */
export function beginUndoRedoPending(target: ProjectState): void {
  target.undoRedoPending = true
  stopWatchdog()
  watchdog = setTimeout(() => {
    watchdog = null
    if (!target.undoRedoPending) return
    log.warn('project', 'undo/redo pending watchdog fired; clearing busy cursor')
    target.undoRedoPending = false
  }, UNDO_PENDING_TIMEOUT_MS)
}

/** Clears the in-flight flag once the resulting snapshot has been applied. */
export function endUndoRedoPending(target: ProjectState): void {
  stopWatchdog()
  target.undoRedoPending = false
}
