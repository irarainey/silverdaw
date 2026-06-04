// Clip Editor keyboard dispatch, extracted from ClipEditorDialog.vue. Two
// handlers cooperate: a window-level capture-phase listener (registered by the
// SFC's onMounted) that wins the race for Space / Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
// regardless of focus drift inside the dialog, and the dialog-root `@keydown`
// handler for the remaining transport / zoom / selection shortcuts. Both defer
// to caller-supplied semantic operations rather than touching view state.

export interface ClipEditorKeyboardDeps {
  isOpen: () => boolean
  hasPlaybackSelection: () => boolean
  close: () => void
  clearSelection: () => void
  extendSelection: (direction: -1 | 1, snapToBeats: boolean) => void
  nudgePlayhead: (direction: -1 | 1, snapToBeats: boolean) => void
  togglePlay: () => void
  toggleLoop: () => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  undoCropLocal: () => void
  redoCropLocal: () => void
}

export interface ClipEditorKeyboard {
  onKeydown: (e: KeyboardEvent) => void
  onWindowKeydownCapture: (e: KeyboardEvent) => void
}

// True when the keydown originated from a field the user is typing into
// (text input, textarea, select, contenteditable). The dialog's transport
// / zoom / undo shortcuts must NOT fire in that case, or they swallow
// digits ("0" → resetZoom), spaces, and arrow keys mid-edit. Uses the
// composed path so it stays correct regardless of focus drift.
function isEditableTarget(e: Event): boolean {
  const el = (e.composedPath?.()[0] as HTMLElement | null) ?? (e.target as HTMLElement | null)
  if (!el) return false
  if (el.isContentEditable) return true
  return el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null
}

export function useClipEditorKeyboard(deps: ClipEditorKeyboardDeps): ClipEditorKeyboard {
  function onWindowKeydownCapture(e: KeyboardEvent): void {
    if (!deps.isOpen()) return
    if (e.isComposing) return
    if (isEditableTarget(e)) return
    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) deps.togglePlay()
      return
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const key = e.key.toLowerCase()
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      deps.undoCropLocal()
      return
    }
    if ((key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey)) {
      e.preventDefault()
      e.stopPropagation()
      deps.redoCropLocal()
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return
    const editable = isEditableTarget(e)
    if (e.key === 'Escape') {
      // While typing in a field, Esc cancels the field focus rather than
      // closing the whole dialog (and never traps the user).
      if (editable) {
        ;(e.target as HTMLElement | null)?.blur()
        return
      }
      // Esc with an active selection clears the selection first; a
      // second Esc closes the dialog. Matches how text-editor and DAW
      // selections behave.
      if (deps.hasPlaybackSelection()) {
        e.preventDefault()
        deps.clearSelection()
        return
      }
      deps.close()
      return
    }
    // No other transport / zoom / undo shortcut should fire while the
    // user is typing into an input — otherwise digits ("0"), spaces and
    // arrow keys get hijacked mid-edit.
    if (editable) return
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D') && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      deps.clearSelection()
      return
    }
    // Dialog-local Undo / Redo: only covers the Crop button's
    // working-view changes. The global undo handler defers to the
    // dialog while `ui.clipEditorOpen` is true, so these shortcuts
    // never leak through to the project-wide undo stack.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        deps.undoCropLocal()
        return
      }
      if ((key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        deps.redoCropLocal()
        return
      }
    }
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault()
      e.stopPropagation()
      deps.togglePlay()
      return
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (e.shiftKey) deps.extendSelection(-1, !e.altKey)
      else deps.nudgePlayhead(-1, !e.altKey)
      return
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (e.shiftKey) deps.extendSelection(1, !e.altKey)
      else deps.nudgePlayhead(1, !e.altKey)
      return
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      deps.zoomIn()
      return
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      deps.zoomOut()
      return
    }
    if (e.key === '0') {
      e.preventDefault()
      deps.resetZoom()
      return
    }
    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault()
      deps.toggleLoop()
    }
  }

  return { onKeydown, onWindowKeydownCapture }
}
