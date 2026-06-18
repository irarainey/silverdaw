// Draft reverse-playback state for the Clip Editor.
//
// Transactional draft: the toggle lives here until Save, when `committed()` is
// persisted via `project.setClipReversed` (or propagated to linked instances via
// `library.updateLibraryClipReversed`); Cancel discards. Reverse is a single
// non-destructive flag on the clip — the source file is never rewritten.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { Clip } from '@/stores/projectStore'

export interface ClipEditorReverseDraft {
  /** The working reverse flag. */
  reversed: Ref<boolean>

  /** True when the draft differs from the clip's persisted reverse flag. */
  hasChanged: ComputedRef<boolean>

  /** Seed the draft from a clip's persisted flag (`null` resets to forward). */
  initialise: (current: Clip | null) => void

  /** Flip the draft flag. */
  toggle: () => void

  /** The flag to persist on Save. */
  committed: () => boolean
}

export function useClipEditorReverseDraft(): ClipEditorReverseDraft {
  const reversed = ref(false)

  // Closure over the live clip so `hasChanged` always compares against the
  // latest persisted state (a Save that mutates the clip then settles the
  // dirty flag without an explicit reset).
  let getCurrentClip: () => Clip | null = () => null

  const hasChanged = computed<boolean>(() => reversed.value !== (getCurrentClip()?.reversed === true))

  function initialise(current: Clip | null): void {
    getCurrentClip = () => current
    reversed.value = current?.reversed === true
  }

  function toggle(): void {
    reversed.value = !reversed.value
  }

  function committed(): boolean {
    return reversed.value
  }

  return { reversed, hasChanged, initialise, toggle, committed }
}
