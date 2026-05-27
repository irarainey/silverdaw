// Module-singleton bridge between any import path that needs to ask
// the user about a sample-rate mismatch, and the
// `SampleRateMismatchDialog` mounted in App.vue. The import flow
// calls `promptSampleRateMismatch(...)` and awaits the user's
// choice; App.vue's watcher renders the dialog and resolves the
// pending promise on each button.
//
// Singleton because every dialog is application-modal: we only ever
// have one in flight at a time. A second `promptSampleRateMismatch`
// call while one is open will reject — the import paths should
// serialise their prompts.

import { ref, type Ref } from 'vue'
import type {
  RateBucket,
  SampleRateMismatchChoice
} from '@/components/SampleRateMismatchDialog.vue'

export type { RateBucket, SampleRateMismatchChoice }

interface PromptState {
  open: boolean
  buckets: RateBucket[]
  projectSampleRate: number
}

const state: Ref<PromptState> = ref({
  open: false,
  buckets: [],
  projectSampleRate: 44100
})

let pendingResolver: ((choice: SampleRateMismatchChoice) => void) | null = null

/**
 * Reactive read of the prompt's open state + props. App.vue binds
 * these to the `<SampleRateMismatchDialog>` instance.
 */
export function useSampleRateMismatchPromptState(): Ref<PromptState> {
  return state
}

/**
 * App.vue calls this from the dialog's `@choose` handler to forward
 * the user's choice back to the import flow's awaiting promise.
 */
export function resolveSampleRateMismatchPrompt(choice: SampleRateMismatchChoice): void {
  state.value = { ...state.value, open: false }
  const resolver = pendingResolver
  pendingResolver = null
  if (resolver) resolver(choice)
}

/**
 * Show the prompt for an import batch and resolve with the user's
 * choice. Rejects if another prompt is already open — callers must
 * serialise their imports.
 */
export function promptSampleRateMismatch(
  buckets: RateBucket[],
  projectSampleRate: number
): Promise<SampleRateMismatchChoice> {
  if (pendingResolver) {
    return Promise.reject(new Error('Sample-rate prompt already open'))
  }
  return new Promise((resolve) => {
    pendingResolver = resolve
    state.value = { open: true, buckets, projectSampleRate }
  })
}
