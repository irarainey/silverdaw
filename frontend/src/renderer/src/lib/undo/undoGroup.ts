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

/**
 * Async counterpart for a single user action whose undoable sends straddle an `await` —
 * an import has to decode before it can add, so its library item and its clip cannot be
 * sent in one synchronous run.
 *
 * Prefer the synchronous form. The backend's depth counter is global, so the group
 * captures every undoable command sent while `body` is in flight, not just the ones
 * `body` issues itself. Keep the awaited work short and self-contained, and never open a
 * group around a dialog or prompt: it would stay open for as long as the user takes to
 * answer, folding anything they did meanwhile into this transaction.
 */
export async function runInUndoGroupAsync<T>(label: string, body: () => Promise<T>): Promise<T> {
  sendBridge('EDIT_GROUP_BEGIN', { label })
  try {
    return await body()
  } finally {
    sendBridge('EDIT_GROUP_END')
  }
}
