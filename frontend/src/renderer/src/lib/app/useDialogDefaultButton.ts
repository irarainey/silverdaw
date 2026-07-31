// Enter-activates-the-primary-button behaviour for every modal in the app.
//
// Dialogs are hand-composed from the `.dialog-*` primitives rather than a single
// wrapper component, so this is installed once at the app shell and works off
// the rendered DOM: any dialog that follows the documented markup gets the
// behaviour for free, including ones added later. That is deliberately cheaper
// to maintain than an Enter handler duplicated across every dialog SFC.
//
// The rules below exist so Enter keeps its *local* meaning wherever the platform
// already gives it one — a newline in a textarea, activating whichever button
// actually has focus, committing a select — and only falls through to the
// primary button when it would otherwise do nothing.

import { onBeforeUnmount, onMounted } from 'vue'

/**
 * The same definition of "a dialog" used by `useRenderedDialogPresence`, so the
 * two agree — including the nested confirm overlays inside the Scratch editor,
 * which sit inside their parent dialog rather than on the backdrop layer.
 */
const DIALOG_SELECTOR = '.dialog-backdrop, [role="dialog"], [role="alertdialog"]'
const PRIMARY_SELECTOR = '.dialog-btn-primary'

export interface DefaultButtonKeyContext {
  key: string
  /** A local handler (or a nested control) has already claimed this Enter. */
  defaultPrevented: boolean
  /** Mid-IME composition: Enter is committing the candidate, not submitting. */
  isComposing: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** Upper-case tag name of the focused element, if any. */
  activeTagName: string | null
  /** True when the focused element already activates itself on Enter. */
  activeIsActivatable: boolean
}

/** Tags whose own Enter behaviour must win over the dialog default. */
const ENTER_OWNING_TAGS = new Set(['TEXTAREA', 'SELECT'])

/**
 * Whether a key event should fall through to the dialog's primary button.
 * Split from the DOM plumbing so the (fiddly) rules can be tested directly.
 */
export function shouldActivateDefaultButton(ctx: DefaultButtonKeyContext): boolean {
  if (ctx.key !== 'Enter') return false
  if (ctx.defaultPrevented || ctx.isComposing) return false
  // Any modifier makes this a different gesture (e.g. Ctrl+Enter shortcuts).
  if (ctx.ctrlKey || ctx.metaKey || ctx.altKey || ctx.shiftKey) return false
  // Enter on a focused button already clicks it — overriding would hijack
  // Cancel, and would fire the primary action twice when it *is* the primary.
  if (ctx.activeIsActivatable) return false
  if (ctx.activeTagName !== null && ENTER_OWNING_TAGS.has(ctx.activeTagName)) return false
  return true
}

function isActivatable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'BUTTON' || tag === 'A') return true
  return el.getAttribute('role') === 'button'
}

/**
 * The dialog the user is actually looking at, or null when none is open.
 *
 * Two things can put a dialog "on top": nesting (a confirm overlay rendered
 * inside its parent dialog) and stacking (a sibling that raises its own
 * z-index, e.g. `z-1200`). Innermost wins first, then highest z-index, then
 * latest in document order.
 */
function topmostDialog(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR))
  const innermost = all.filter(
    (dialog) => !all.some((other) => other !== dialog && dialog.contains(other))
  )
  let top: HTMLElement | null = null
  let topZ = -Infinity
  for (const dialog of innermost) {
    const parsed = Number.parseInt(getComputedStyle(dialog).zIndex, 10)
    const zIndex = Number.isNaN(parsed) ? 0 : parsed
    if (zIndex >= topZ) {
      topZ = zIndex
      top = dialog
    }
  }
  return top
}

/**
 * The enabled primary button in `dialog`'s footer, or null.
 *
 * Strictly footer-scoped: a primary-styled button in the dialog *body* is an
 * inline action (“Add”, “Restore”), not the dialog's accept, and falling back
 * to one would let Enter fire an unrelated action whenever the real accept was
 * disabled. Buttons belonging to a dialog stacked or nested inside this one are
 * likewise skipped, as are ones that are disabled or not rendered.
 */
function primaryButtonOf(dialog: HTMLElement): HTMLButtonElement | null {
  const selector = `.dialog-footer ${PRIMARY_SELECTOR}`
  for (const button of dialog.querySelectorAll<HTMLButtonElement>(selector)) {
    if (button.closest(DIALOG_SELECTOR) !== dialog) continue
    if (button.disabled || button.offsetParent === null) continue
    return button
  }
  return null
}

/**
 * Installs the app-wide "Enter accepts the dialog" behaviour. Call once, from
 * the application shell.
 */
export function useDialogDefaultButton(): void {
  function onKeydown(event: KeyboardEvent): void {
    const active = document.activeElement
    if (
      !shouldActivateDefaultButton({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        activeTagName: active instanceof HTMLElement ? active.tagName : null,
        activeIsActivatable: isActivatable(active)
      })
    ) {
      return
    }

    const dialog = topmostDialog()
    if (!dialog) return
    // Focus parked outside the dialog (or inside a different one) means this
    // Enter isn't aimed at the topmost dialog, so leave it alone.
    if (active instanceof HTMLElement && active !== document.body) {
      if (active.closest(DIALOG_SELECTOR) !== dialog) return
    }

    const button = primaryButtonOf(dialog)
    if (!button) return
    event.preventDefault()
    button.click()
  }

  // Bubble phase, so a dialog's own handler can claim Enter first by calling
  // `preventDefault()` — the same escape hatch inputs already rely on.
  onMounted(() => document.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
}
