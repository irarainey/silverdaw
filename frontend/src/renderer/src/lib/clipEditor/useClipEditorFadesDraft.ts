// Draft fade-in / fade-out state for the Clip Editor.
//
// Mirrors the contract enforced by `useClipEditorWarpDraft`: the dialog
// is transactional, so all fade edits live here until the user clicks
// **Save**. Save commits via `project.setClipFades`; Cancel discards
// the draft entirely. The draft is also what the preview voice plays
// back while editing, so dragging the fade-in input is audible
// immediately even though nothing is persisted yet.
//
// Why a dedicated hook (separate from warp): the editor's tabs are
// independent UX surfaces, and folding fades into the warp draft would
// couple two unrelated mental models. A small focused hook lets the
// Fades tab own its lifecycle cleanly and keeps the dirty-check
// reasoning local.
//
// Units: BOTH fields are clip-local **post-warp / timeline ms** — the
// same units the backend's `OffsetSource::applyFadeGain` consumes and
// `setClipFades` persists. The `initialise` helper accepts persisted
// fields that the projectStore stores as `undefined` for the
// no-fade common case (see `setClipFades` in `projectStore.ts`) and
// normalises them to `0` so `hasChanged` doesn't trip on the
// `0 !== undefined` foot-gun.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Clip } from '@/stores/projectStore'

/** Smallest fade delta the UI cares about. Matches the per-keystroke
 *  granularity of the number input (1 ms steps) so accidentally
 *  re-rounded floats don't appear dirty. */
const FADE_EPS_MS = 0.5

function normaliseFade(v: number | undefined | null): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0
  return v
}

function clampNonNegative(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0
  return v
}

export interface ClipEditorFadesDraft {
  // ─── Draft state ───
  draftFadeInMs: Ref<number>
  draftFadeOutMs: Ref<number>

  // ─── Derived view ───
  /** True when the draft differs from the persisted clip values by at
   *  least `FADE_EPS_MS`. Compares against the LIVE clip ref each read
   *  so a Save that mutates the clip immediately settles the dirty
   *  flag without an explicit reset. */
  hasChanged: ComputedRef<boolean>

  // ─── Lifecycle ───
  /** Seed the draft from a clip — called every time the dialog opens
   *  on a fresh target. `null` resets to defaults (both 0). */
  initialise: (current: Clip | null) => void

  /** Record which side the user just edited so a subsequent combined
   *  clamp trims the OTHER side. The Fades panel calls this from its
   *  v-model computed setters (the only call sites that know which
   *  input fired). */
  markEdited: (side: 'in' | 'out') => void

  /** Clamp the draft so individual values are >= 0 AND their sum
   *  doesn't exceed `effectiveDurationMs` (the timeline / post-warp
   *  length of the audible window — NOT source duration). Called by
   *  the dialog right before Save so the backend never has to silently
   *  clip values the UI presented as accepted. Trims the most-recently
   *  edited field if the sum overflows. */
  clampAgainstDuration: (effectiveDurationMs: number) => void
}

export function useClipEditorFadesDraft(): ClipEditorFadesDraft {
  const draftFadeInMs = ref(0)
  const draftFadeOutMs = ref(0)
  // Track which input was set most recently so a combined-clamp can
  // trim the OTHER value rather than the just-typed one. `null` means
  // neither has been touched since the last initialise().
  let lastEdited: 'in' | 'out' | null = null

  // Hold a getter for the current clip so `hasChanged` always compares
  // against the latest persisted state, not a snapshot captured at
  // initialise time. The dialog supplies this via `initialise`.
  let getCurrentClip: () => Clip | null = () => null

  const hasChanged = computed<boolean>(() => {
    const clip = getCurrentClip()
    const persistedIn = normaliseFade(clip?.fadeInMs)
    const persistedOut = normaliseFade(clip?.fadeOutMs)
    return (
      Math.abs(draftFadeInMs.value - persistedIn) > FADE_EPS_MS ||
      Math.abs(draftFadeOutMs.value - persistedOut) > FADE_EPS_MS
    )
  })

  function initialise(current: Clip | null): void {
    // Capture the live clip ref by closure so subsequent edits to its
    // persisted fade fields (post-Save) automatically settle the
    // dirty flag without an explicit reset.
    getCurrentClip = () => current
    draftFadeInMs.value = normaliseFade(current?.fadeInMs)
    draftFadeOutMs.value = normaliseFade(current?.fadeOutMs)
    lastEdited = null
  }

  function markEdited(side: 'in' | 'out'): void {
    lastEdited = side
  }

  function clampAgainstDuration(effectiveDurationMs: number): void {
    const dur = effectiveDurationMs > 0 ? effectiveDurationMs : 0
    if (dur <= 0) {
      draftFadeInMs.value = 0
      draftFadeOutMs.value = 0
      return
    }
    draftFadeInMs.value = Math.min(clampNonNegative(draftFadeInMs.value), dur)
    draftFadeOutMs.value = Math.min(clampNonNegative(draftFadeOutMs.value), dur)
    const sum = draftFadeInMs.value + draftFadeOutMs.value
    if (sum > dur) {
      // Combined fades exceed audible window — trim the side that
      // wasn't just edited so the user's most recent intention wins.
      const trim = lastEdited === 'in' ? 'out' : 'in'
      if (trim === 'out') {
        draftFadeOutMs.value = Math.max(0, dur - draftFadeInMs.value)
      } else {
        draftFadeInMs.value = Math.max(0, dur - draftFadeOutMs.value)
      }
    }
  }

  return {
    draftFadeInMs,
    draftFadeOutMs,
    hasChanged,
    initialise,
    markEdited,
    clampAgainstDuration
  }
}
