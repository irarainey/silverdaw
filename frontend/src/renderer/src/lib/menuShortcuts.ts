// Renderer-side keyboard-shortcut handler.
//
// The custom HTML menu bar (`AppTitleBar.vue`) displays the accelerator strings
// next to each menu item, but Electron's native menu is suppressed
// (`Menu.setApplicationMenu(null)` in main) so those accelerators are inert
// out of the box. This module walks the same `menus` definition and registers
// a single document-level `keydown` listener that translates matching key
// events into the same `menuAction` IPC the click handler uses.
//
// Why renderer-side and not `globalShortcut` in main? Two reasons:
//   1. `globalShortcut` registers system-wide and would steal Ctrl+S etc.
//      from every other app while Silverdaw has the focus or not.
//   2. We need to defer to browser-native behaviour when focus is in a
//      text input — Ctrl+Z / X / C / V / A on the project-name rename
//      field should edit the text, not invoke a (non-existent) project
//      undo. A renderer listener can see the focus target; main cannot.

import { buildMenus } from '@/menu'
import { useUiStore } from '@/stores/uiStore'

interface ParsedAccelerator {
  /** Lower-case `e.key` to match. Single-char keys are letters (e.g. `'s'`);
   * function keys use the long form (`'f11'`, `'f12'`). */
  key: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/**
 * Actions that should NOT fire when focus is in a text input — let the
 * browser handle them natively (undo, copy, paste, …). The menu items
 * still call `wc.undo()` etc. when invoked via the menu UI, which is a
 * no-op outside a text field; that's fine.
 */
const TEXT_EDIT_ACTIONS: ReadonlySet<string> = new Set([
  'edit.undo',
  'edit.redo',
  'edit.cut',
  'edit.copy',
  'edit.paste',
  // 'S' (no modifiers) opens Split-at-Playhead. Defer to native text
  // input when the user is typing — they almost certainly mean the
  // letter, not the global accelerator.
  'edit.splitAtPlayhead',
  // 'D' (no modifiers) duplicates the selected clip — same rationale.
  'edit.duplicateClip',
  // Delete key — defer to native when a text input has focus so
  // pressing Delete inside the project rename field removes the
  // character under the cursor rather than the selected clip.
  'edit.deleteClip'
])

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
  // `e.key` returns the printable character (case-sensitive — the
  // user holding Shift gives an upper-case letter). Lower-case it
  // so the comparison is shift-agnostic; the shift modifier itself
  // is checked separately.
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

/**
 * Wire every enabled menu item with an `accelerator` to a document-level
 * `keydown` listener that fires the same `menuAction` IPC the click
 * handler does. Returns a teardown function the caller should invoke
 * on `onBeforeUnmount`.
 *
 * `opts.debugMode` mirrors the same flag that drives Debug menu
 * visibility; the F12 / Toggle Developer Tools accelerator is only
 * bound when the menu it lives in is itself visible.
 */
export function registerMenuShortcuts(opts: { debugMode: boolean }): () => void {
  // Pre-parse the menu definitions into a flat list. Disabled items
  // are skipped — their accelerator is shown for documentation only.
  const bindings: { accel: ParsedAccelerator; action: string }[] = []
  for (const menu of buildMenus(opts)) {
    for (const item of menu.items) {
      if (!item.action || !item.accelerator || item.disabled) continue
      const accel = parseAccelerator(item.accelerator)
      if (accel) bindings.push({ accel, action: item.action })
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Modal dialogs that own their own keyboard interactions (e.g.
    // the Clip Editor's local undo / redo stack) need the accelerator
    // to reach their bubble-phase handler. Bailing here lets the
    // dialog's `@keydown` see the event without our `stopPropagation`
    // pre-empting it.
    if (useUiStore().clipEditorOpen) return
    for (const b of bindings) {
      if (!matches(e, b.accel)) continue
      if (isEditableTarget(e.target) && TEXT_EDIT_ACTIONS.has(b.action)) {
        // Let the browser handle undo/cut/copy/paste natively while
        // the user is typing — much better UX than re-invoking the
        // menu action through main.
        return
      }
      e.preventDefault()
      e.stopPropagation()
      window.silverdaw.menuAction(b.action)
      return
    }
  }

  // Capture phase so we beat any deeper component listeners (e.g. the
  // rename input committing on Enter — the accelerator binding for
  // Ctrl+S still gets first crack at the event).
  window.addEventListener('keydown', onKeyDown, { capture: true })
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
}
