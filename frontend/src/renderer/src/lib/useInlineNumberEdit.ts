// Turns a numeric readout into a double-click-to-type field: shows the current value as
// text, and on commit parses, steps, and clamps it to the control's range before applying.
// Presentational/interaction state only — the caller owns the value via `get`/`set`, so this
// composable never touches the store. Mirrors the track gain dB-entry interaction.

import { nextTick, ref, type Ref } from 'vue'

export interface InlineNumberEditOptions {
  /** Current committed value, read when editing begins. */
  get: () => number
  /** Apply a parsed, stepped, clamped value. */
  set: (value: number) => void
  min: number
  max: number
  /** Rounding step for the committed value (default 1). */
  step?: number
}

export interface InlineNumberEdit {
  editing: Ref<boolean>
  text: Ref<string>
  inputRef: Ref<HTMLInputElement | null>
  begin: () => void
  commit: () => void
  cancel: () => void
  onKeydown: (e: KeyboardEvent) => void
}

export function useInlineNumberEdit(options: InlineNumberEditOptions): InlineNumberEdit {
  const editing = ref(false)
  const text = ref('')
  const inputRef = ref<HTMLInputElement | null>(null)

  function begin(): void {
    text.value = String(options.get())
    editing.value = true
    void nextTick(() => {
      inputRef.value?.focus()
      inputRef.value?.select()
    })
  }

  function commit(): void {
    if (!editing.value) return
    const parsed = Number(text.value.trim())
    if (text.value.trim() !== '' && Number.isFinite(parsed)) {
      const step = options.step ?? 1
      const stepped = Math.round(parsed / step) * step
      options.set(Math.min(options.max, Math.max(options.min, stepped)))
    }
    editing.value = false
  }

  function cancel(): void {
    editing.value = false
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  return { editing, text, inputRef, begin, commit, cancel, onKeydown }
}
