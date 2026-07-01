// Draft turntable-effect state (brake / backspin) for the Clip Editor.
//
// Transactional draft: the toggles live here until Save, when `committedBrake`
// / `committedBackspin` are persisted via `project.setClipBrake` /
// `project.setClipBackspin`; Cancel discards. Both are non-destructive per-clip
// tail effects (the source file is never rewritten) and are mutually exclusive —
// a clip can have a brake OR a backspin, never both, so turning one on clears the
// other, mirroring the backend and timeline context-menu behaviour.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Clip } from '@/stores/projectStore'

export interface ClipEditorDjEffectDraft {
  /** The working brake flag. */
  brake: Ref<boolean>

  /** The working backspin flag. */
  backspin: Ref<boolean>

  /** True when either draft flag differs from the clip's persisted state. */
  hasChanged: ComputedRef<boolean>

  /** Seed both drafts from a clip's persisted flags (`null` resets to off). */
  initialise: (current: Clip | null) => void

  /** Flip the brake draft; turning it on clears backspin. */
  toggleBrake: () => void

  /** Flip the backspin draft; turning it on clears brake. */
  toggleBackspin: () => void

  /** Clear both drafts (e.g. when the clip becomes reversed). */
  clear: () => void

  /** The brake flag to persist on Save. */
  committedBrake: () => boolean

  /** The backspin flag to persist on Save. */
  committedBackspin: () => boolean
}

export function useClipEditorDjEffectDraft(): ClipEditorDjEffectDraft {
  const brake = ref(false)
  const backspin = ref(false)

  // Closure over the live clip so `hasChanged` always compares against the
  // latest persisted state (a Save that mutates the clip then settles the
  // dirty flag without an explicit reset).
  let getCurrentClip: () => Clip | null = () => null

  const hasChanged = computed<boolean>(() => {
    const clip = getCurrentClip()
    return brake.value !== (clip?.brake === true) || backspin.value !== (clip?.backspin === true)
  })

  function initialise(current: Clip | null): void {
    getCurrentClip = () => current
    brake.value = current?.brake === true
    backspin.value = current?.backspin === true
  }

  function toggleBrake(): void {
    const next = !brake.value
    brake.value = next
    if (next) backspin.value = false
  }

  function toggleBackspin(): void {
    const next = !backspin.value
    backspin.value = next
    if (next) brake.value = false
  }

  function clear(): void {
    brake.value = false
    backspin.value = false
  }

  function committedBrake(): boolean {
    return brake.value
  }

  function committedBackspin(): boolean {
    return backspin.value
  }

  return {
    brake,
    backspin,
    hasChanged,
    initialise,
    toggleBrake,
    toggleBackspin,
    clear,
    committedBrake,
    committedBackspin
  }
}
