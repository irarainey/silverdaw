// Transaction-level undo grouping. A single user action that emits several undoable bridge
// commands (split, duplicate, paste, a clip-editor save that re-pushes every linked clip, …) must
// be ONE undo step. Wrap the command sequence in `runInUndoGroup`: it brackets the sends with
// EDIT_GROUP_BEGIN/END so the backend folds them all into one UndoManager transaction.
//
// The backend nests groups via a depth counter, so wrapped actions may freely call other wrapped
// actions. EDIT_GROUP_END is always sent (even if the body throws or returns early) so a group can
// never be left open.

import { send as sendBridge } from '@/lib/bridgeService'

/**
 * Run `body` with its undoable bridge sends collapsed into a single undo step.
 * `label` names the transaction for the Undo/Redo menu (e.g. "Split clip").
 * Returns whatever `body` returns.
 */
export function runInUndoGroup<T>(label: string, body: () => T): T {
  sendBridge('EDIT_GROUP_BEGIN', { label })
  try {
    return body()
  } finally {
    sendBridge('EDIT_GROUP_END')
  }
}
