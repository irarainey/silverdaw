// Adds a magnetic centre detent (and optional double-click reset) to a native range
// `<input>`. Bipolar sliders — pitch, pan, tone bands — have a neutral midpoint the user
// expects to be able to drag back to reliably; without a detent the exact centre is a
// pixel-perfect target that is easy to miss. When a drag lands within a small band of the
// detent value the slider snaps to it, so releasing near the middle always returns to zero.
//
// Purely presentational: the directive mutates the input's value and re-emits a native
// `input` event so the element's existing v-model / handlers (which own persistence and
// undo) see the snapped value. It never talks to the store directly.

import type { Directive } from 'vue'

// Fraction of the slider's total range within which a drag snaps to the detent.
const SNAP_FRACTION = 0.03

/**
 * Snap `raw` to `detent` when it falls within the detent band, otherwise return it unchanged.
 * The detent only applies when it sits strictly inside the [min, max] track.
 */
export function snapToDetent(raw: number, detent: number, min: number, max: number): number {
  if (!Number.isFinite(raw) || !Number.isFinite(detent) || !Number.isFinite(min) || !Number.isFinite(max)) {
    return raw
  }
  if (!(detent > min && detent < max)) return raw
  const band = (max - min) * SNAP_FRACTION
  return Math.abs(raw - detent) <= band ? detent : raw
}

interface DetentConfig {
  value: number
  reset: boolean
}

/** Accept either a bare detent number or `{ value, reset }`; return null when disabled. */
export function parseDetentBinding(value: unknown): DetentConfig | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value, reset: false } : null
  }
  if (value !== null && typeof value === 'object') {
    const v = (value as { value?: unknown }).value
    if (typeof v === 'number' && Number.isFinite(v)) {
      return { value: v, reset: (value as { reset?: unknown }).reset === true }
    }
  }
  return null
}

interface DetentState {
  config: DetentConfig | null
  onInput: () => void
  onDblClick: () => void
}

const STORE = new WeakMap<HTMLInputElement, DetentState>()

export const vSliderDetent: Directive<HTMLInputElement, unknown> = {
  mounted(el, binding) {
    let snapping = false

    const onInput = (): void => {
      if (snapping) return
      const state = STORE.get(el)
      if (!state?.config) return
      const raw = Number(el.value)
      const snapped = snapToDetent(raw, state.config.value, Number(el.min), Number(el.max))
      if (snapped !== raw) {
        el.value = String(snapped)
        // Re-emit so v-model / @input handlers pick up the snapped value. The following
        // release `change` reads the already-snapped element value, so it is not re-emitted
        // here (which would double any commit/undo step).
        snapping = true
        el.dispatchEvent(new Event('input', { bubbles: true }))
        snapping = false
      }
    }

    const onDblClick = (): void => {
      const state = STORE.get(el)
      const cfg = state?.config
      if (!cfg || !cfg.reset) return
      if (!(cfg.value >= Number(el.min) && cfg.value <= Number(el.max))) return
      el.value = String(cfg.value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    STORE.set(el, { config: parseDetentBinding(binding.value), onInput, onDblClick })
    el.addEventListener('input', onInput)
    el.addEventListener('dblclick', onDblClick)
  },
  updated(el, binding) {
    const state = STORE.get(el)
    if (state) state.config = parseDetentBinding(binding.value)
  },
  beforeUnmount(el) {
    const state = STORE.get(el)
    if (!state) return
    el.removeEventListener('input', state.onInput)
    el.removeEventListener('dblclick', state.onDblClick)
    STORE.delete(el)
  }
}
