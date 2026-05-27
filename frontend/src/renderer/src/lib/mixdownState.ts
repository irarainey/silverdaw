// Renderer-side mixdown render state.
//
// Tracks the currently-active mixdown render (if any) so the
// `MixdownProgressDialog` can mount/dismiss off a single reactive
// source of truth and listeners outside Vue (e.g. the bridge dispatch
// in `bridgeService.ts`) can push updates into it without importing
// the dialog directly.
//
// The model is intentionally simple — at most one mixdown can be in
// flight at a time (the backend's `MixdownEngine` is a single-slot
// state machine). A `null` value means "no render in progress".

import { ref, readonly, type Ref } from 'vue'
import type { MixdownFailedPayload, MixdownProgressPayload } from '@shared/bridge-protocol'

export type MixdownStage = MixdownProgressPayload['stage']

export interface MixdownActiveState {
  /** 0..100 progress as broadcast by the backend. */
  percent: number
  /** Latest stage label so the dialog can surface the current phase. */
  stage: MixdownStage
  /** Absolute output path the render is targeting — surfaced in the
   *  done toast and used to verify path consistency across envelopes. */
  outputPath: string
  /** Format the user requested. Used to build the success toast
   *  message ("Exported MIXDOWN.WAV"). */
  format: 'wav' | 'mp3'
}

const state: Ref<MixdownActiveState | null> = ref(null)

export function useMixdownState(): Readonly<Ref<MixdownActiveState | null>> {
  return readonly(state)
}

/**
 * Start tracking a new mixdown. Called by `ExportMixdownDialog` right
 * after it dispatches `MIXDOWN_START`. The dialog stays open just
 * long enough to swap to the progress dialog.
 */
export function beginMixdown(outputPath: string, format: 'wav' | 'mp3'): void {
  state.value = { percent: 0, stage: 'prepare', outputPath, format }
}

/**
 * Apply a `MIXDOWN_PROGRESS` envelope. No-op if no render is tracked
 * (e.g. a stale envelope arrives after cancel — drop it).
 */
export function applyMixdownProgress(payload: MixdownProgressPayload): void {
  if (!state.value) return
  state.value = {
    ...state.value,
    percent: Math.max(state.value.percent, payload.percent),
    stage: payload.stage
  }
}

/** Clear the active state. Called on done, fail, or cancel. */
export function clearMixdownState(): void {
  state.value = null
}

/** Inspect the last-known target path / format for a toast caller. */
export function snapshotMixdownState(): MixdownActiveState | null {
  return state.value
}

export type { MixdownFailedPayload }
