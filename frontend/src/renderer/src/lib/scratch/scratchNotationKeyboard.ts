// Keyboard interaction commands for the Scratch Notation Editor.
// Handles selection, deletion, point addition, and movement via keyboard
// shortcuts. Designed to coexist with input fields, buttons, and dialog
// behavior (Escape, Backspace, Delete).

import type { NotationLane, ScratchNotationEditor } from './useScratchNotationEditor'

/** Step size in microseconds for keyboard time-nudge. */
const TIME_STEP_US = 10_000
/** Step size in turns for keyboard platter-nudge. */
const TURNS_STEP = 0.01
/** Step size for keyboard crossfader-nudge. */
const CF_STEP = 0.02

export interface KeyboardCommandContext {
  editor: ScratchNotationEditor
  durationUs: number
}

/**
 * Returns true if the event target is an element that should retain native
 * keyboard behavior (inputs, buttons, contenteditable).
 */
function isNativeTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  if (!target) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'BUTTON') return true
  if (target.isContentEditable) return true
  return false
}

/**
 * Handle a keydown event in the notation editor. Returns true if the event
 * was consumed and propagation should stop.
 */
export function handleNotationKeydown(
  event: KeyboardEvent,
  ctx: KeyboardCommandContext
): boolean {
  const { editor } = ctx

  // Let native targets (inputs, buttons) handle their own keys.
  if (isNativeTarget(event)) {
    // Exception: if the user presses Escape in a text input, let it blur the
    // input rather than bubble to dialog close.
    if (event.key === 'Escape') {
      const target = event.target as HTMLElement
      if (target.tagName === 'INPUT') {
        target.blur()
        event.preventDefault()
        event.stopPropagation()
        return true
      }
    }
    return false
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'z' || event.key === 'Z')) {
    event.preventDefault()
    event.stopPropagation()
    editor.undo()
    return true
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'y' || event.key === 'Y')) {
    event.preventDefault()
    event.stopPropagation()
    editor.redo()
    return true
  }

  // Delete / Backspace — delete selected keyframe
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (editor.selection.value) {
      event.preventDefault()
      event.stopPropagation()
      editor.deleteSelected()
      return true
    }
    return false
  }

  if ((event.key === 'd' || event.key === 'D') && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!editor.selection.value) return false
    event.preventDefault()
    event.stopPropagation()
    editor.clearSelection()
    return true
  }

  // Space — play/pause toggle (placeholder, no-op for notation-only scope)
  // Do NOT handle here to avoid conflict with dialog/global shortcuts.

  // Arrow keys — nudge selected keyframe or add a new point
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    return handleArrowKey(event, ctx)
  }

  // Insert / Enter — add a new keyframe at midpoint of selection or pattern center
  if (event.key === 'Insert' || (event.key === 'Enter' && !event.ctrlKey)) {
    return handleInsertKey(event, ctx)
  }

  // T — toggle touch state on selected platter point
  if (event.key === 't' || event.key === 'T') {
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      return handleToggleTouch(event, ctx)
    }
  }

  return false
}

function handleArrowKey(event: KeyboardEvent, ctx: KeyboardCommandContext): boolean {
  const { editor, durationUs } = ctx
  const sel = editor.selection.value
  if (!sel) return false

  event.preventDefault()
  event.stopPropagation()

  const pattern = editor.pattern.value
  if (!pattern) return false

  const largeStep = event.shiftKey

  if (sel.lane === 'platter') {
    const kf = pattern.platter[sel.index]
    if (!kf) return false
    let timeUs = kf.timeUs
    let turns = kf.turns

    if (event.key === 'ArrowLeft') {
      timeUs = Math.max(0, timeUs - (largeStep ? TIME_STEP_US * 5 : TIME_STEP_US))
    } else if (event.key === 'ArrowRight') {
      timeUs = Math.min(durationUs, timeUs + (largeStep ? TIME_STEP_US * 5 : TIME_STEP_US))
    } else if (event.key === 'ArrowUp') {
      turns += largeStep ? TURNS_STEP * 5 : TURNS_STEP
    } else if (event.key === 'ArrowDown') {
      turns -= largeStep ? TURNS_STEP * 5 : TURNS_STEP
    }

    editor.movePlatter(sel.index, timeUs, turns)
    return true
  }

  if (sel.lane === 'crossfader') {
    const kf = pattern.crossfader[sel.index]
    if (!kf) return false
    let timeUs = kf.timeUs
    let value = kf.value

    if (event.key === 'ArrowLeft') {
      timeUs = Math.max(0, timeUs - (largeStep ? TIME_STEP_US * 5 : TIME_STEP_US))
    } else if (event.key === 'ArrowRight') {
      timeUs = Math.min(durationUs, timeUs + (largeStep ? TIME_STEP_US * 5 : TIME_STEP_US))
    } else if (event.key === 'ArrowUp') {
      value = Math.min(1, value + (largeStep ? CF_STEP * 5 : CF_STEP))
    } else if (event.key === 'ArrowDown') {
      value = Math.max(0, value - (largeStep ? CF_STEP * 5 : CF_STEP))
    }

    editor.moveCrossfader(sel.index, timeUs, value)
    return true
  }

  return false
}

function handleInsertKey(event: KeyboardEvent, ctx: KeyboardCommandContext): boolean {
  const { editor, durationUs } = ctx
  event.preventDefault()
  event.stopPropagation()

  const sel = editor.selection.value
  const pattern = editor.pattern.value
  if (!pattern) return false

  // Determine insertion lane and time
  let lane: NotationLane = 'platter'
  let insertTimeUs = Math.round(durationUs / 2)

  if (sel) {
    lane = sel.lane
    if (lane === 'platter') {
      const kf = pattern.platter[sel.index]
      const next = pattern.platter[sel.index + 1]
      if (kf && next) {
        insertTimeUs = Math.round((kf.timeUs + next.timeUs) / 2)
      } else if (kf) {
        insertTimeUs = Math.round(kf.timeUs + TIME_STEP_US)
      }
    } else {
      const kf = pattern.crossfader[sel.index]
      const next = pattern.crossfader[sel.index + 1]
      if (kf && next) {
        insertTimeUs = Math.round((kf.timeUs + next.timeUs) / 2)
      } else if (kf) {
        insertTimeUs = Math.round(kf.timeUs + TIME_STEP_US)
      }
    }
  }

  insertTimeUs = Math.max(1, Math.min(durationUs - 1, insertTimeUs))

  if (lane === 'platter') {
    editor.addPlatter(insertTimeUs)
  } else {
    editor.addCrossfaderPoint(insertTimeUs)
  }
  return true
}

function handleToggleTouch(event: KeyboardEvent, ctx: KeyboardCommandContext): boolean {
  const { editor } = ctx
  const sel = editor.selection.value
  if (!sel || sel.lane !== 'platter') return false

  const pattern = editor.pattern.value
  if (!pattern) return false

  const kf = pattern.platter[sel.index]
  if (!kf) return false

  event.preventDefault()
  event.stopPropagation()
  editor.togglePlatterTouch(sel.index)
  return true
}
