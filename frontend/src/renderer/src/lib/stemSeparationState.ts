// Renderer-side stem-separation state: a single reactive source of truth for the
// active separation job so a progress dialog mounts/dismisses off it and non-Vue
// listeners (bridge dispatch) can push updates without importing the dialog.
// At most one job is in flight (the backend separator is single-slot); `null`
// means no separation in progress.

import { ref, readonly, type Ref } from 'vue'
import type { StemName, StemProgressPayload, StemReadyPayload } from '@shared/bridge-protocol'

export type StemStage = StemProgressPayload['stage']

/** What a separation produces and where (if anywhere) its stems are placed. The
 *  renderer is the single source of truth for this so the bridge envelopes stay
 *  minimal and placement never depends on echoed fields. */
export interface StemSeparationTarget {
  /** Resolved top-level source the stems derive from. */
  sourceItemId: string
  /** Friendly source name for filenames, track names, and the dialog. */
  sourceName: string
  /** Present for timeline separations: place stems on new tracks aligned to this
   *  clip. Absent for library-source separations (stems imported to library only). */
  clipId?: string
  /** Start of the source clip (ms) used to align placed stem clips. */
  startMs?: number
  /** The source clip's trim-in (ms) at separation time. A clip-scoped separation
   *  extracts only [inMs, inMs+duration) of the source, so the stem WAV's sample 0
   *  is source-time `inMs`. The inherited beat grid is shifted back by this so it
   *  lands on the stem's own timeline. Absent/0 for full-source separations. */
  sourceInMs?: number
}

export interface StemSeparationActiveState {
  /** Correlation id minted by the renderer when dispatching STEM_SEPARATE. */
  jobId: string
  /** Source and placement intent; the source is never mutated. */
  target: StemSeparationTarget
  /** Stems being extracted, in canonical order; drives the progress counter. */
  stems: readonly StemName[]
  /** 0..100 progress as broadcast by the backend. */
  percent: number
  /** Latest stage label so the dialog can surface the current phase. */
  stage: StemStage
  /** Optional per-step context (e.g. the stem name currently being separated). */
  detail?: string
}

const state: Ref<StemSeparationActiveState | null> = ref(null)

export function useStemSeparationState(): Readonly<Ref<StemSeparationActiveState | null>> {
  return readonly(state)
}

/**
 * Start tracking a new separation. Called right after the renderer dispatches
 * STEM_SEPARATE so the progress dialog opens immediately.
 */
export function beginStemSeparation(
  jobId: string,
  target: StemSeparationTarget,
  stems: readonly StemName[]
): void {
  state.value = { jobId, target, stems: [...stems], percent: 0, stage: 'prepare' }
}

/**
 * Apply a STEM_PROGRESS envelope. No-op if no job is tracked, or if the envelope
 * belongs to a different (stale) job — guards against late ticks after cancel.
 */
export function applyStemProgress(payload: StemProgressPayload): void {
  if (!state.value || state.value.jobId !== payload.jobId) return
  state.value = {
    ...state.value,
    percent: Math.max(state.value.percent, payload.percent),
    stage: payload.stage,
    detail: payload.detail
  }
}

/** Clear the active state. Called on ready, fail, or cancel. */
export function clearStemSeparationState(): void {
  state.value = null
}

/** Inspect the active job (e.g. to confirm a ready/failed envelope is current). */
export function snapshotStemSeparationState(): StemSeparationActiveState | null {
  return state.value
}

export type { StemReadyPayload }
