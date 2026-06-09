// Single source of truth for the selectable crossfade recipes. Both the
// timeline context menu and its tests read this list so the menu rows, on-state
// checks, and dispatch tokens cannot drift from the bridge `TransitionRecipe`
// kinds. FX-based recipes (bass swap, filter fade, delay out) are not yet
// audible on the audio thread and are deliberately omitted until their DSP
// lands.

import type { TransitionRecipe } from '@shared/bridge-protocol'

export type TransitionRecipeKind = TransitionRecipe['kind']

export interface TransitionRecipeOption {
  readonly kind: TransitionRecipeKind
  readonly label: string
  readonly description: string
}

export const TRANSITION_RECIPES: ReadonlyArray<TransitionRecipeOption> = [
  {
    kind: 'smooth',
    label: 'Smooth blend',
    description: 'Equal-power crossfade that holds blend energy constant.'
  },
  {
    kind: 'linear',
    label: 'Fade out / in',
    description: 'Straight amplitude fades — one clip down as the other comes up.'
  }
]
