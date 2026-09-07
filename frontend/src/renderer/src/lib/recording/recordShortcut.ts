// Which keys the Record Audio dialog claims, split from the DOM plumbing so the
// (fiddly) rules can be tested directly — the same shape `shouldActivateDefaultButton`
// uses for the dialog Enter key.

export interface RecordShortcutContext {
  /** `KeyboardEvent.key`. */
  key: string
  /** `tagName` of the event target, or null when it is not an element. */
  targetTagName: string | null
  /** `type` of the event target when it is an `<input>`. */
  targetInputType: string | null
  /** True when the target is contenteditable. */
  targetIsContentEditable: boolean
  /** True once a take has been captured and the dialog is showing the review. */
  isReviewing: boolean
}

/**
 * True when this keypress should start or stop a take.
 *
 * Space is claimed from whatever holds focus. Starting and stopping is the one thing a
 * performer does with their hands off the mouse, so it cannot depend on where focus
 * happens to be — a space that toggles the last checkbox they clicked is worse than
 * useless mid-performance. The caller pairs this with `preventDefault()`, which is what
 * stops a focused button or checkbox acting on the same press: both activate on the keyup
 * that suppresses, so the key does one thing and never two.
 *
 * `R` alone defers to a focused `<select>`, whose letter keys drive the input-device
 * picker's type-ahead; taking it there would cost that for no gain, since space already
 * covers the control. Neither key fires while a text field has focus — that is the take
 * name, which exists only in review, where recording is over anyway.
 */
export function isRecordShortcutKey(ctx: RecordShortcutContext): boolean {
  if (ctx.isReviewing) return false

  const editingText =
    (ctx.targetTagName === 'INPUT' && ctx.targetInputType === 'text') ||
    ctx.targetTagName === 'TEXTAREA' ||
    ctx.targetIsContentEditable
  if (editingText) return false

  if (ctx.key === ' ') return true
  if (ctx.key !== 'r' && ctx.key !== 'R') return false
  return ctx.targetTagName !== 'SELECT'
}
