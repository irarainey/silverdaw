// Renderer-side menu accelerators for the custom HTML menu bar.
// Avoid `globalShortcut`: these bindings must be app-scoped and defer to editable targets.

import { buildMenus } from '@/menu'
import type { BuildMenusOptions } from '@/menu'
import { useUiStore } from '@/stores/uiStore'
import { useTransportStore } from '@/stores/transportStore'

interface ParsedAccelerator {
  key: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/** Actions deferred to native editable-target behavior. */
const TEXT_EDIT_ACTIONS: ReadonlySet<string> = new Set([
  'edit.undo',
  'edit.redo',
  'edit.cut',
  'edit.copy',
  'edit.paste',
  // Plain letters defer to text inputs.
  'edit.splitAtPlayhead',
  'edit.duplicateClip',
  // Delete also belongs to the focused input.
  'edit.deleteClip'
])

/** Display-only accelerators owned by App.vue's global shortcut handler. */
const GLOBAL_SHORTCUT_ACTIONS: ReadonlySet<string> = new Set([
  'view.zoomIn',
  'view.zoomOut',
  'view.zoomReset'
])

/** Extra key aliases for existing menu actions that the menu can't show a second
 *  accelerator for. `Ctrl+D` complements the bare `D` duplicate, and `Backspace`
 *  complements `Delete`. Dispatch and editable-target deferral reuse the action's
 *  existing rules (both are in `TEXT_EDIT_ACTIONS`). */
const ALIAS_ACCELERATORS: ReadonlyArray<{ accel: string; action: string }> = [
  { accel: 'Ctrl+D', action: 'edit.duplicateClip' },
  { accel: 'Backspace', action: 'edit.deleteClip' }
]

function parseAccelerator(accel: string): ParsedAccelerator | null {
  const parts = accel
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return null
  const rawKey = parts[parts.length - 1]
  if (!rawKey) return null
  const modifiers = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()))
  return {
    key: rawKey.toLowerCase(),
    ctrl: modifiers.has('ctrl') || modifiers.has('cmdorctrl'),
    shift: modifiers.has('shift'),
    alt: modifiers.has('alt') || modifiers.has('option'),
    meta: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('super')
  }
}

function eventKey(e: KeyboardEvent): string {
  // Match printable keys case-insensitively; Shift is checked separately.
  return e.key.toLowerCase()
}

function matches(e: KeyboardEvent, accel: ParsedAccelerator): boolean {
  if (eventKey(e) !== accel.key) return false
  if (e.ctrlKey !== accel.ctrl) return false
  if (e.shiftKey !== accel.shift) return false
  if (e.altKey !== accel.alt) return false
  if (e.metaKey !== accel.meta) return false
  return true
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

export interface ShortcutBinding {
  accel: ParsedAccelerator
  action: string
}

/** Flatten enabled top-level menu accelerators; exported for DOM-free tests. */
export function collectShortcutBindings(opts: BuildMenusOptions): ShortcutBinding[] {
  const bindings: ShortcutBinding[] = []
  for (const menu of buildMenus(opts)) {
    for (const item of menu.items) {
      if (!item.action || !item.accelerator || item.disabled) continue
      if (GLOBAL_SHORTCUT_ACTIONS.has(item.action)) continue
      const accel = parseAccelerator(item.accelerator)
      if (accel) bindings.push({ accel, action: item.action })
    }
  }
  // Extra key aliases for actions the menu already exposes under a different key.
  for (const alias of ALIAS_ACCELERATORS) {
    const accel = parseAccelerator(alias.accel)
    if (accel) bindings.push({ accel, action: alias.action })
  }
  if (opts.devToolsEnabled) {
    const accel = parseAccelerator('F12')
    if (accel) bindings.push({ accel, action: 'view.toggleDevTools' })
  }
  return bindings
}

/** Register menu accelerators and return the teardown function. */
export function registerMenuShortcuts(opts: { devToolsEnabled: boolean }): () => void {
  const bindings = collectShortcutBindings(opts)

  function onKeyDown(e: KeyboardEvent): void {
    // Recovery gates the UI; swallow accelerators until the engine is usable.
    if (useTransportStore().engineRecovery !== 'ok') {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    // Modal dialogs own their local keyboard handlers.
    if (useUiStore().clipEditorOpen) return
    for (const b of bindings) {
      if (!matches(e, b.accel)) continue
      if (isEditableTarget(e.target) && TEXT_EDIT_ACTIONS.has(b.action)) {
        // Let editable targets keep native text shortcuts.
        return
      }
      e.preventDefault()
      e.stopPropagation()
      window.silverdaw.menuAction(b.action)
      return
    }
  }

  // Capture phase lets app accelerators run before component listeners.
  window.addEventListener('keydown', onKeyDown, { capture: true })
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
}
