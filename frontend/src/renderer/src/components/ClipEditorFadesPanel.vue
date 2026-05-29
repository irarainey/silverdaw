<script setup lang="ts">
// Fades tab inside the Clip Editor's bottom panel area. Pure presentation:
// the draft state + dirty-check live in `useClipEditorFadesDraft`, owned
// by the parent dialog so Save / Cancel can commit / discard atomically
// alongside the other tabs' drafts.
//
// The control is a custom stepper (− / value / +) rather than a native
// `type="number"` input: native spinners can't be themed to match the
// dark UI and their default 1-step is far too fine for a millisecond
// fade (1000ms = 1s). Here typing is free-form (any value can be keyed
// in), and the buttons nudge in musically sensible STEP_MS increments.

import { ref, watch } from 'vue'
import type { ClipEditorFadesDraft } from '@/lib/clipEditor/useClipEditorFadesDraft'

const props = defineProps<{
  draft: ClipEditorFadesDraft
}>()

// Stepper increment. 100ms is coarse enough to dial a fade quickly
// (10 clicks = 1s) yet fine enough for short clips. Manual entry still
// accepts any value, so this is just the nudge size.
const STEP_MS = 100

const draftFadeInMs = props.draft.draftFadeInMs
const draftFadeOutMs = props.draft.draftFadeOutMs

// Local text buffers so the user can clear the field and type freely
// without it snapping back to a number mid-keystroke. Kept in sync with
// the draft whenever the draft changes from elsewhere (open, stepper,
// pre-Save clamp).
const fadeInText = ref(String(Math.round(draftFadeInMs.value)))
const fadeOutText = ref(String(Math.round(draftFadeOutMs.value)))

watch(draftFadeInMs, (v) => {
  const next = String(Math.round(v))
  if (next !== fadeInText.value) fadeInText.value = next
})
watch(draftFadeOutMs, (v) => {
  const next = String(Math.round(v))
  if (next !== fadeOutText.value) fadeOutText.value = next
})

function setFade(side: 'in' | 'out', value: number): void {
  const clamped = Math.max(0, Math.round(value))
  if (side === 'in') draftFadeInMs.value = clamped
  else draftFadeOutMs.value = clamped
  props.draft.markEdited(side)
}

// Live typing: commit the parsed value. No upper bound is enforced
// here — the canvas overlay clamps the fade to the audible window
// visually, and the dialog clamps the persisted value on Save. Keeping
// the input itself unbounded means manual entry of any length always
// works (an earlier cap silently limited typing). An empty / invalid
// field is left alone so backspacing to retype doesn't force a 0.
function onInput(side: 'in' | 'out', raw: string): void {
  if (side === 'in') fadeInText.value = raw
  else fadeOutText.value = raw
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return
  setFade(side, parsed)
}

// On blur, normalise: an empty / invalid field commits 0 and the text
// snaps to the committed value.
function onBlur(side: 'in' | 'out', raw: string): void {
  const parsed = Number.parseInt(raw, 10)
  const committed = Math.max(0, Number.isFinite(parsed) ? parsed : 0)
  setFade(side, committed)
  const text = String(committed)
  if (side === 'in') fadeInText.value = text
  else fadeOutText.value = text
}

// Stepper nudge. Snap to the nearest STEP_MS grid first so a manually
// typed odd value lands on a clean multiple after the first click.
function step(side: 'in' | 'out', dir: 1 | -1): void {
  const current = side === 'in' ? draftFadeInMs.value : draftFadeOutMs.value
  const snapped = Math.round(current / STEP_MS) * STEP_MS
  setFade(side, snapped + dir * STEP_MS)
}
</script>

<template>
  <div class="flex w-full flex-col gap-3 text-xs">
    <fieldset class="grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-900/70 p-3">
      <label class="flex flex-col gap-1.5">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">
          Fade in
        </span>
        <div class="flex items-stretch overflow-hidden rounded border border-zinc-700 bg-zinc-950 focus-within:border-sky-500">
          <button
            type="button"
            class="flex w-7 shrink-0 items-center justify-center border-r border-zinc-700 bg-zinc-800 text-sm text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 active:bg-zinc-600 disabled:opacity-40 disabled:hover:bg-zinc-800"
            :disabled="draftFadeInMs <= 0"
            aria-label="Decrease fade in"
            @click="step('in', -1)"
          >
            −
          </button>
          <input
            :value="fadeInText"
            type="text"
            inputmode="numeric"
            class="min-w-0 flex-1 bg-transparent px-2 py-1 text-right font-mono text-xs text-zinc-100 focus:outline-none"
            @input="onInput('in', ($event.target as HTMLInputElement).value)"
            @blur="onBlur('in', ($event.target as HTMLInputElement).value)"
            @keydown.enter.prevent="onBlur('in', ($event.target as HTMLInputElement).value)"
          >
          <button
            type="button"
            class="flex w-7 shrink-0 items-center justify-center border-l border-zinc-700 bg-zinc-800 text-sm text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 active:bg-zinc-600 disabled:opacity-40 disabled:hover:bg-zinc-800"
            aria-label="Increase fade in"
            @click="step('in', 1)"
          >
            +
          </button>
        </div>
        <span class="text-[10px] text-zinc-500">ms</span>
      </label>

      <label class="flex flex-col gap-1.5">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">
          Fade out
        </span>
        <div class="flex items-stretch overflow-hidden rounded border border-zinc-700 bg-zinc-950 focus-within:border-sky-500">
          <button
            type="button"
            class="flex w-7 shrink-0 items-center justify-center border-r border-zinc-700 bg-zinc-800 text-sm text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 active:bg-zinc-600 disabled:opacity-40 disabled:hover:bg-zinc-800"
            :disabled="draftFadeOutMs <= 0"
            aria-label="Decrease fade out"
            @click="step('out', -1)"
          >
            −
          </button>
          <input
            :value="fadeOutText"
            type="text"
            inputmode="numeric"
            class="min-w-0 flex-1 bg-transparent px-2 py-1 text-right font-mono text-xs text-zinc-100 focus:outline-none"
            @input="onInput('out', ($event.target as HTMLInputElement).value)"
            @blur="onBlur('out', ($event.target as HTMLInputElement).value)"
            @keydown.enter.prevent="onBlur('out', ($event.target as HTMLInputElement).value)"
          >
          <button
            type="button"
            class="flex w-7 shrink-0 items-center justify-center border-l border-zinc-700 bg-zinc-800 text-sm text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 active:bg-zinc-600 disabled:opacity-40 disabled:hover:bg-zinc-800"
            aria-label="Increase fade out"
            @click="step('out', 1)"
          >
            +
          </button>
        </div>
        <span class="text-[10px] text-zinc-500">ms</span>
      </label>
    </fieldset>
  </div>
</template>
