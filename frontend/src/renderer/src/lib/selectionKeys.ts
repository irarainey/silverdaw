/**
 * Opt-out for components that drive their own selection from the keyboard.
 *
 * Both app-wide keyboard owners — the menu accelerators and the global
 * shortcuts — listen on `window` in the capture phase, so they see a key before
 * the focused component does and cannot be called off by `stopPropagation`.
 * A container marks itself with `data-owns-selection-keys="true"` to claim the
 * selection keys for whatever is focused inside it, and both owners stand aside.
 */
export const SELECTION_KEYS_ATTRIBUTE = 'data-owns-selection-keys'

/** Keys a self-navigating list claims: moving its selection and acting on it.
 *  Left/Right are not included — no such list uses them, so they stay with the
 *  global playhead seek. */
export const SELECTION_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'Enter'])

/** True when the focused element sits inside a list that handles its own
 *  selection keys. */
export function ownsSelectionKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest(`[${SELECTION_KEYS_ATTRIBUTE}="true"]`) !== null
}
