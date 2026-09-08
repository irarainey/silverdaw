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
  if (isEditingText(ctx)) return false

  if (ctx.key === ' ') return true
  if (ctx.key !== 'r' && ctx.key !== 'R') return false
  return ctx.targetTagName !== 'SELECT'
}

/**
 * True when this keypress should start or stop the review audition.
 *
 * The mirror of the rule above, for the other half of the dialog: space records while a
 * take is being made and plays it back once there is one, so the same key means "hear
 * what this does" throughout. It is claimed from whatever holds focus for the same reason
 * — review is a listening step, and the controls being weighed up (the arrangement tick,
 * the backing level, the channel options) are exactly the ones the user has just clicked,
 * so a space that re-toggles the last of them instead of replaying the take is the wrong
 * answer every time. The caller pairs this with `preventDefault()` so the focused control
 * does not also act on the press.
 *
 * The take name is the one exception: it is a text field, and a space typed into it has
 * to be a space.
 */
export function isReviewPlayShortcutKey(ctx: RecordShortcutContext): boolean {
  if (!ctx.isReviewing) return false
  if (isEditingText(ctx)) return false
  return ctx.key === ' '
}

function isEditingText(ctx: RecordShortcutContext): boolean {
  return (
    (ctx.targetTagName === 'INPUT' && ctx.targetInputType === 'text') ||
    ctx.targetTagName === 'TEXTAREA' ||
    ctx.targetIsContentEditable
  )
}
