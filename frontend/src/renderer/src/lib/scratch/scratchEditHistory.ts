// Bounded local undo/redo history for Scratch Editor draft edits.
// Scoped to the open editor session — cleared on close, draft replacement,
// or engine recovery. Does not write to the project undo stack.

import type { ScratchPattern } from '@shared/bridge-protocol'

const MAX_HISTORY_DEPTH = 50

export interface ScratchEditHistory {
  /** Push the current state before an edit. */
  push(snapshot: ScratchPattern): void
  /** Undo: pop from undo stack, push current to redo, return previous state. */
  undo(current: ScratchPattern): ScratchPattern | null
  /** Redo: pop from redo stack, push current to undo, return next state. */
  redo(current: ScratchPattern): ScratchPattern | null
  /** Clear all history (on session close, draft replacement, recovery). */
  clear(): void
  canUndo(): boolean
  canRedo(): boolean
  undoDepth(): number
  redoDepth(): number
}

export function createScratchEditHistory(): ScratchEditHistory {
  let undoStack: ScratchPattern[] = []
  let redoStack: ScratchPattern[] = []

  function push(snapshot: ScratchPattern): void {
    undoStack.push(snapshot)
    if (undoStack.length > MAX_HISTORY_DEPTH) {
      undoStack = undoStack.slice(undoStack.length - MAX_HISTORY_DEPTH)
    }
    redoStack = []
  }

  function undo(current: ScratchPattern): ScratchPattern | null {
    const prev = undoStack.pop()
    if (!prev) return null
    redoStack.push(current)
    return prev
  }

  function redo(current: ScratchPattern): ScratchPattern | null {
    const next = redoStack.pop()
    if (!next) return null
    undoStack.push(current)
    return next
  }

  function clear(): void {
    undoStack = []
    redoStack = []
  }

  return {
    push,
    undo,
    redo,
    clear,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undoDepth: () => undoStack.length,
    redoDepth: () => redoStack.length
  }
}
