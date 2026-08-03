// Keeps a numeric `<input>` displayed at a fixed number of decimals (e.g. "120.00",
// "100.00") while the underlying model stays a plain number for the maths.
//
// A number input bound straight to a ref shows whatever the number stringifies to,
// so 100 renders as "100" and 99.5 as "99.5" — the warp fields jitter between one,
// two and no decimals as the value changes. Formatting on every keystroke instead
// would fight the user, turning "1" into "1.00" mid-type, so the display only
// reformats while the field is not focused.
import { ref, watch, type Ref } from 'vue'

/** A fixed-decimal text projection of a numeric model, for binding to an input. */
export interface DecimalFieldText {
  /** Bind to the input's `:value`. */
  text: Ref<string>
  onFocus: () => void
  onInput: (e: Event) => void
  onBlur: () => void
  /** Re-format from the model after changing it programmatically (e.g. a wheel step). */
  sync: () => void
}

/**
 * Project `model` into a `text` ref always formatted to `decimals` places, except
 * while the field is focused, where the user's raw keystrokes are shown verbatim.
 *
 * Blank or non-numeric input leaves the model untouched, so a half-typed value
 * ("", "-", "1.") never writes a garbage number; blur restores the display from
 * whatever the model actually holds.
 *
 * Blur also quantises the model to the displayed precision, so the value in use is
 * always the value on screen — typing "100.567" into a two-decimal field applies
 * 100.57, not a 100.567 the field can never show.
 */
export function useDecimalFieldText(model: Ref<number>, decimals = 2): DecimalFieldText {
  const text = ref('')
  let focused = false

  function format(): string {
    const value = model.value
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(decimals) : ''
  }

  function sync(): void {
    text.value = format()
  }

  watch(model, () => {
    if (!focused) sync()
  }, { immediate: true })

  return {
    text,
    sync,
    onFocus(): void {
      focused = true
    },
    onInput(e: Event): void {
      const raw = (e.target as HTMLInputElement).value
      text.value = raw
      const parsed = Number(raw.trim())
      if (raw.trim() !== '' && Number.isFinite(parsed)) model.value = parsed
    },
    onBlur(): void {
      focused = false
      const value = model.value
      if (typeof value === 'number' && Number.isFinite(value)) {
        const quantised = Number(value.toFixed(decimals))
        if (quantised !== value) model.value = quantised
      }
      sync()
    }
  }
}
