import { defineStore } from 'pinia'
import { ScratchPatternSchema } from '@shared/bridge-protocol'
import type { ScratchPattern, ScratchPatternRecordedPayload, ScratchSessionStatePayload } from '@shared/bridge-protocol'
import { canonicalizeScratchPattern } from '@/lib/scratch/scratchPatternCanonical'

export type ScratchRecordingStatus = 'empty' | 'recording' | 'completed'

export interface ScratchSourcePeaks {
  sessionId: string
  peaks: Float32Array
  channels: readonly Float32Array[]
  peaksPerSecond: number
  sampleRate: number
}

interface ScratchSessionState {
  current: ScratchSessionStatePayload | null
  sourcePeaks: ScratchSourcePeaks | null
  recordingStatus: ScratchRecordingStatus
  completedPattern: ScratchPattern | null
  /** Monotonically increasing revision for draft change detection. */
  draftRevision: number
  /** Id of the saved pattern this draft was most recently saved as, or null if unsaved. */
  savedPatternId: string | null
  /** Canonical serialization of the pattern at the last acknowledged save/load point.
   *  Used for content-based dirty detection instead of ID-only comparison. */
  savedCanonicalBaseline: string | null
  /** Library item id of an in-flight bake-to-sample save, or null when idle. */
  bakePendingItemId: string | null
  /** Monotonic counter bumped on each resolved bake so watchers fire per-result. */
  bakeResultSeq: number
  /** Outcome of the most recently resolved bake-to-sample save. */
  bakeResult: { itemId: string; ok: boolean; error: string | null } | null
}

export const useScratchSessionStore = defineStore('scratchSession', {
  state: (): ScratchSessionState => ({
    current: null,
    sourcePeaks: null,
    recordingStatus: 'empty',
    completedPattern: null,
    draftRevision: 0,
    savedPatternId: null,
    savedCanonicalBaseline: null,
    bakePendingItemId: null,
    bakeResultSeq: 0,
    bakeResult: null
  }),

  getters: {
    /** True when the store holds an active session with a completed pattern ready for editing. */
    hasEditablePattern(): boolean {
      return this.current !== null && this.completedPattern !== null
    },

    /** Active session ID or null. */
    activeSessionId(): string | null {
      return this.current?.sessionId ?? null
    },

    /** True when the draft has edits that have not yet been saved to the backend.
     *  Compares current pattern content against the canonical baseline, not just IDs. */
    isSavedPatternDirty(): boolean {
      if (this.completedPattern === null) return false
      if (this.savedCanonicalBaseline === null) return true
      return canonicalizeScratchPattern(this.completedPattern) !== this.savedCanonicalBaseline
    }
  },

  actions: {
    applyState(payload: ScratchSessionStatePayload): void {
      // Exact-session validation: reject stale/closed session state that
      // could clear or replace the active session.
      if (this.current !== null && this.current.sessionId !== payload.sessionId) {
        // A state update for a different session while we already have one
        // active — discard silently. This prevents a delayed/stale session A
        // from overwriting active session B.
        return
      }
      // Accept preparing-state when lifecycle is awaiting the first
      // backend-generated ID (current is null).
      // Re-arming after a take must discard the existing scratch so the new
      // recording starts from a clean slate — matching a fresh session. Both the
      // on-screen Record button and physical MIDI Play arm funnel through this
      // state update, so clearing on the rising edge of `armed` covers every input
      // source and clears the notation the moment recording is armed (not only once
      // capture starts).
      const wasArmed = this.current?.armed === true
      if (
        payload.armed === true &&
        !wasArmed &&
        payload.status !== 'recording' &&
        this.completedPattern !== null
      ) {
        this.clearRecording()
      }
      this.current = payload
      if (payload.status === 'recording') {
        this.recordingStatus = 'recording'
      }
    },

    applyPatternRecorded(payload: ScratchPatternRecordedPayload): void {
      if (!this.current || this.current.sessionId !== payload.sessionId) return
      this.completedPattern = payload.pattern
      this.recordingStatus = 'completed'
      this.draftRevision += 1
    },

    setSourcePeaks(sourcePeaks: ScratchSourcePeaks): void {
      if (this.current?.sessionId !== sourcePeaks.sessionId) return
      this.sourcePeaks = sourcePeaks
    },

    /**
     * Replace the draft pattern explicitly (e.g. from undo/redo or validated edit).
     * Rejects if no active session or the pattern fails schema validation.
     * Returns true on success.
     */
    replacePattern(pattern: ScratchPattern): boolean {
      if (!this.current) return false
      const result = ScratchPatternSchema.safeParse(pattern)
      if (!result.success) return false
      this.completedPattern = result.data
      this.draftRevision += 1
      return true
    },

    /**
     * Load a previously saved pattern back into the session as the completed draft
     * (used when re-opening a saved scratch from the library). Unlike `replacePattern`
     * this also flips `recordingStatus` to `completed` so the notation editor shows the
     * pattern and Save/Play become available. Requires an active session.
     */
    loadSavedPattern(pattern: ScratchPattern): boolean {
      if (!this.current) return false
      const result = ScratchPatternSchema.safeParse(pattern)
      if (!result.success) return false
      this.completedPattern = result.data
      this.recordingStatus = 'completed'
      this.draftRevision += 1
      return true
    },

    /** Mark a bake-to-sample save as in flight for the given library item id. */
    beginScratchBake(itemId: string): void {
      this.bakePendingItemId = itemId
      this.bakeResult = null
    },

    /** Resolve the in-flight bake if it matches; no-op for unrelated SAMPLE_SAVED acks. */
    resolveScratchBake(itemId: string, ok: boolean, error: string | null): void {
      if (this.bakePendingItemId !== itemId) return
      this.bakePendingItemId = null
      this.bakeResultSeq += 1
      this.bakeResult = { itemId, ok, error }
    },


    editPattern(sessionId: string, pattern: ScratchPattern): boolean {
      if (!this.current || this.current.sessionId !== sessionId) return false
      const result = ScratchPatternSchema.safeParse(pattern)
      if (!result.success) return false
      this.completedPattern = result.data
      this.draftRevision += 1
      return true
    },

    /** Check whether the given session ID matches the currently active session. */
    isActiveSession(sessionId: string): boolean {
      return this.current !== null && this.current.sessionId === sessionId
    },

    clearRecording(): void {
      this.completedPattern = null
      this.recordingStatus = 'empty'
      this.savedPatternId = null
      this.savedCanonicalBaseline = null
      this.draftRevision += 1
    },

    clear(): void {
      this.current = null
      this.sourcePeaks = null
      this.recordingStatus = 'empty'
      this.completedPattern = null
      this.savedPatternId = null
      this.savedCanonicalBaseline = null
      this.draftRevision = 0
      this.bakePendingItemId = null
    },

    /** Record that the current draft was saved to the backend with the given pattern id.
     *  When baseline is provided, stores it as the canonical content reference for dirty detection. */
    setSavedPatternId(id: string | null, baseline?: string | null): void {
      this.savedPatternId = id
      if (baseline !== undefined) {
        this.savedCanonicalBaseline = baseline
      } else if (id === null) {
        this.savedCanonicalBaseline = null
      }
    },

    /** Update only the name portion of the canonical baseline (for authoritative renames).
     *  No-op if no baseline is currently stored. */
    updateBaselineName(newName: string): void {
      if (this.savedCanonicalBaseline === null) return
      try {
        const parsed = JSON.parse(this.savedCanonicalBaseline) as Record<string, unknown>
        parsed.name = newName
        this.savedCanonicalBaseline = JSON.stringify(parsed)
      } catch {
        // Defensive: if baseline is corrupt, clear it.
        this.savedCanonicalBaseline = null
      }
    }
  }
})
