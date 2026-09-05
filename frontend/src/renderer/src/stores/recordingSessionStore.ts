import { defineStore } from 'pinia'
import type {
  RecordingInputLevelPayload,
  RecordingInputSelection,
  RecordingInputsListPayload,
  RecordingReadyPayload,
  RecordingSessionStatePayload
} from '@shared/bridge-protocol'

/** Review-waveform peaks for the finished recording. Peaks, not audio: the file
 *  stays on disk and is only ever referenced by path (ADR 0003). */
export interface RecordingPeaks {
  recordingId: string
  peaks: Float32Array
  channels: readonly Float32Array[]
  peaksPerSecond: number
  sampleRate: number
}

/** How many closed sessions to remember. Broadcasts only ever lag by one
 *  session, so a short history is enough to reject them all. */
const CLOSED_SESSION_MEMORY = 8

/** Give up on the Rescan spinner if the backend never answers, so the button
 *  cannot be left disabled. Mirrors the output-device rescan. */
const INPUT_RESCAN_SAFETY_MS = 6000
let inputRescanSafetyTimer: ReturnType<typeof setTimeout> | null = null

interface RecordingSessionState {
  /** True while the Record Audio dialog is open. One dialog, hosted once in
   *  App.vue, so its visibility lives with the session it drives. */
  dialogOpen: boolean
  /** Mirror of the backend session; null when no session is open. */
  current: RecordingSessionStatePayload | null
  /** Input devices as the backend enumerated them. Kept across dialog opens:
   *  scanning every driver is slow and the device set rarely changes, so the
   *  dialog shows the cached list and Rescan is the way to refresh it. */
  inputs: RecordingInputsListPayload | null
  /** True from a user-initiated Rescan until the refreshed list arrives. */
  rescanningInputs: boolean
  /** User-scope remembered input, resolved by the renderer from Electron
   *  preferences (the backend never sees it). */
  rememberedInput: RecordingInputSelection | null
  /** The driver pinned in Preferences ▸ Audio, or null for automatic. Held apart
   *  from the resolved session input so opening the dialog on a different driver
   *  never rewrites the user's choice. */
  preferredInputTypeName: string | null
  /** Input gain remembered from the last session, applied as soon as the next one
   *  opens: a microphone's level belongs to the setup, not to one take. */
  rememberedInputGainDb: number
  /** Live input peaks, always metered even with monitoring off. */
  inputPeakL: number
  inputPeakR: number
  /** The finalised recording awaiting a commit decision, or null. */
  ready: RecordingReadyPayload | null
  readyPeaks: RecordingPeaks | null
  /** Library item id of an in-flight commit, correlated against SAMPLE_SAVED
   *  exactly as the scratch bake does. */
  commitPendingItemId: string | null
  /** Bumped per resolved commit so watchers fire once per result. */
  commitResultSeq: number
  commitResult: { itemId: string; ok: boolean; error: string | null } | null
  /** Sessions this renderer has closed. A late broadcast for one of them must
   *  never replace the live session. */
  closedSessionIds: string[]
}

export const useRecordingSessionStore = defineStore('recordingSession', {
  state: (): RecordingSessionState => ({
    dialogOpen: false,
    current: null,
    inputs: null,
    rescanningInputs: false,
    rememberedInput: null,
    preferredInputTypeName: null,
    rememberedInputGainDb: 0,
    inputPeakL: 0,
    inputPeakR: 0,
    ready: null,
    readyPeaks: null,
    commitPendingItemId: null,
    commitResultSeq: 0,
    commitResult: null,
    closedSessionIds: []
  }),

  getters: {
    activeSessionId(): string | null {
      return this.current?.sessionId ?? null
    },

    /** True while audio is being captured, so the dialog can lock the settings
     *  that cannot change mid-recording. */
    isRolling(): boolean {
      return this.current?.status === 'countIn' || this.current?.status === 'recording'
    },

    /** A finished recording is waiting to be kept or discarded. */
    isReviewing(): boolean {
      return this.current?.status === 'review' && this.ready !== null
    },

    /** No capture device at all — the dialog says so rather than showing an
     *  empty picker that looks broken. */
    hasNoInput(): boolean {
      const listing = this.inputs
      if (listing === null) return false
      return listing.types.every((type) => type.devices.length === 0)
    }
  },

  actions: {
    /** Open the Record Audio dialog. Hydrating the remembered input first means
     *  the session opens on the user's device rather than switching under them.
     *  An empty driver is legitimate — it means Preferences has not pinned one,
     *  so the backend picks whichever driver offers the device. */
    async openDialog(): Promise<void> {
      const saved = await window.silverdaw.getAudioInput().catch(() => null)
      this.preferredInputTypeName = saved?.typeName ?? null
      this.rememberedInputGainDb = saved?.gainDb ?? 0
      this.rememberedInput = saved?.deviceName
        ? { typeName: saved.typeName ?? '', deviceName: saved.deviceName }
        : null
      this.dialogOpen = true
    },

    closeDialog(): void {
      this.dialogOpen = false
    },

    /** Note a session this renderer has closed, so late broadcasts are ignored.
     *  Only the most recent few matter — anything older cannot still be in flight. */
    noteClosed(sessionId: string): void {
      if (this.closedSessionIds.includes(sessionId)) return
      this.closedSessionIds.push(sessionId)
      if (this.closedSessionIds.length > CLOSED_SESSION_MEMORY) this.closedSessionIds.shift()
    },

    applyInputs(payload: RecordingInputsListPayload): void {
      this.inputs = payload
      this.finishInputRescan()
    },

    /** Show rescan progress until the refreshed list arrives. */
    beginInputRescan(): void {
      this.rescanningInputs = true
      if (inputRescanSafetyTimer) clearTimeout(inputRescanSafetyTimer)
      inputRescanSafetyTimer = setTimeout(() => {
        inputRescanSafetyTimer = null
        this.rescanningInputs = false
      }, INPUT_RESCAN_SAFETY_MS)
    },

    /** Clear the rescan state, including its fallback timeout. */
    finishInputRescan(): void {
      if (inputRescanSafetyTimer) {
        clearTimeout(inputRescanSafetyTimer)
        inputRescanSafetyTimer = null
      }
      this.rescanningInputs = false
    },

    applyState(payload: RecordingSessionStatePayload): void {
      // Reject state for a session we are not showing: a delayed update from a
      // closed session must never replace the live one.
      if (this.closedSessionIds.includes(payload.sessionId)) return
      if (this.current !== null && this.current.sessionId !== payload.sessionId) return
      this.current = payload
      // Leaving review means the finished recording is no longer on offer.
      if (payload.status !== 'review' && payload.status !== 'finalising') {
        this.ready = null
        this.readyPeaks = null
      }
      if (!this.isRolling) {
        this.inputPeakL = 0
        this.inputPeakR = 0
      }
    },

    applyInputLevel(payload: RecordingInputLevelPayload): void {
      if (this.current?.sessionId !== payload.sessionId) return
      this.inputPeakL = payload.peakL
      this.inputPeakR = payload.peakR
    },

    applyRecordingReady(payload: RecordingReadyPayload): void {
      if (this.current?.sessionId !== payload.sessionId) return
      this.ready = payload
      this.readyPeaks = null
    },

    setReadyPeaks(peaks: RecordingPeaks): void {
      if (this.ready?.recordingId !== peaks.recordingId) return
      this.readyPeaks = peaks
    },

    setRememberedInput(input: RecordingInputSelection | null): void {
      this.rememberedInput = input
    },

    beginCommit(itemId: string): void {
      this.commitPendingItemId = itemId
      this.commitResult = null
    },

    /** Resolve an in-flight commit; unrelated SAMPLE_SAVED acks are ignored. */
    resolveCommit(itemId: string, ok: boolean, error: string | null): void {
      if (this.commitPendingItemId !== itemId) return
      this.commitPendingItemId = null
      this.commitResultSeq += 1
      this.commitResult = { itemId, ok, error }
    },

    clear(): void {
      this.current = null
      this.inputPeakL = 0
      this.inputPeakR = 0
      this.ready = null
      this.readyPeaks = null
      this.commitPendingItemId = null
    }
  }
})
