import { defineStore } from 'pinia'
import type {
  RecordingCalibrateStatePayload,
  RecordingCalibrateStatus,
  RecordingCountInBars,
  RecordingInputLevelPayload,
  RecordingInputSelection,
  RecordingInputsListPayload,
  RecordingMode,
  RecordingReadyPayload,
  RecordingSessionStatePayload,
  RecordingWindowMode
} from '@shared/bridge-protocol'
import { RECORDING_PROTOCOL_VERSION } from '@shared/bridge-protocol'
import { send as sendBridge } from '@/lib/bridgeService'
import { buildDeviceOptions } from '@/lib/recording/recordingInputOptions'
import { useAudioDeviceStore } from '@/stores/audioDeviceStore'
import { useTransportStore } from '@/stores/transportStore'

/** Stable key for a stored calibration. Both device names take part: the same microphone
 *  through a different output is a different round trip. Mirrors `latencyCalibrationKey` in
 *  Electron main, which owns the persisted map. */
function calibrationKey(
  inputDeviceName: string | null | undefined,
  outputDeviceName: string | null | undefined
): string {
  return `${(inputDeviceName ?? '').trim()}\u0000${(outputDeviceName ?? '').trim()}`
}

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
  /** True while the device list is being fetched — the first load when the dialog
   *  opens as well as a user-initiated Rescan. Both are the same wait to the user
   *  and the same spinner. */
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
  /** Dialog settings carried across opens within this app session. They belong to
   *  how the user is working right now, not to the project, so they are held in
   *  memory rather than written to preferences or the project file. Null means
   *  the user has not chosen yet, so the backend's own seed stands. */
  rememberedWindowMode: RecordingWindowMode | null
  rememberedBackingTrackIds: string[] | null
  /** Backing level (0..1) carried across opens; monitoring only, so it is never
   *  written to the project or to preferences. */
  rememberedBackingGain: number | null
  /** Backing level (0..1) for the review pane, held apart from the one above: a
   *  guide mix deliberately kept quiet under the performer is not how anyone
   *  wants to hear the take back. Full by default. */
  rememberedReviewBackingGain: number
  rememberedCountInBars: RecordingCountInBars | null
  rememberedClickEnabled: boolean | null
  /** Whether takes are committed as musical material, carried across opens. */
  rememberedRecordingMode: RecordingMode | null
  /** Whether the performer hears their own input, carried across opens. */
  rememberedMonitorEnabled: boolean | null
  /** Whether takes get the noise-reduction pass, carried across opens. */
  rememberedCleanupEnabled: boolean | null
  /** Whether a mono take is saved as a stereo file, carried across takes so a
   *  retake does not have to be told again. */
  rememberedStereoDuplicated: boolean
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
  /** Stored round trips, keyed by input+output device pair (ADR 0030, Amendment 17).
   *  Loaded from app preferences when the dialog opens; absent = uncalibrated, which is a
   *  normal state the dialog shows rather than nags about. */
  calibrations: Record<string, LatencyCalibrationDto>
  /** Live progress of a measurement run. Separate from the session status because
   *  calibration is a side errand, not a stage of recording. */
  calibrateStatus: RecordingCalibrateStatus
  calibrateClicksDetected: number
  calibrateClicksTotal: number
  /** The figure the last run produced, offered for the user to accept. Held apart from the
   *  stored calibration so a measurement is never applied without being accepted. */
  calibrateResultMs: number | null
  calibrateError: string | null
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
    rememberedWindowMode: null,
    rememberedBackingTrackIds: null,
    rememberedBackingGain: null,
    rememberedReviewBackingGain: 1,
    rememberedCountInBars: null,
    rememberedClickEnabled: null,
    rememberedRecordingMode: null,
    rememberedMonitorEnabled: null,
    rememberedCleanupEnabled: null,
    rememberedStereoDuplicated: false,
    inputPeakL: 0,
    inputPeakR: 0,
    ready: null,
    readyPeaks: null,
    commitPendingItemId: null,
    commitResultSeq: 0,
    commitResult: null,
    closedSessionIds: [],
    calibrations: {},
    calibrateStatus: 'idle',
    calibrateClicksDetected: 0,
    calibrateClicksTotal: 0,
    calibrateResultMs: null,
    calibrateError: null
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

    /** True whenever a take is in hand and the setup must not be touched: rolling, or
     *  being written out. Finalising looks idle from the dialog's point of view — the
     *  review pane has not appeared yet — but changing the input there would re-arm the
     *  session underneath the take that is still being finished. */
    isSetupLocked(): boolean {
      return this.isRolling || this.current?.status === 'finalising'
    },

    /** A finished recording is waiting to be kept or discarded. */
    isReviewing(): boolean {
      return this.current?.status === 'review' && this.ready !== null
    },

    /** True between opening the dialog and the backend's first session state.
     *  Opening a capture device is not instant, so the form shows the settings it
     *  is about to settle on and says it is still working rather than presenting
     *  a dead, half-built panel. */
    awaitingSession(): boolean {
      return this.dialogOpen && this.current === null
    },

    /** No capture device at all — the dialog says so rather than showing an
     *  empty picker that looks broken. Asked of the same builder the picker
     *  fills itself from, so the two cannot disagree: Windows exposes pseudo
     *  capture endpoints ("Primary Sound Capture Driver", "Microsoft Sound
     *  Mapper") that are filtered out of the list, and counting raw device
     *  names instead left a machine with only those showing an empty, disabled
     *  picker and no explanation. */
    hasNoInput(): boolean {
      const listing = this.inputs
      if (listing === null) return false
      return buildDeviceOptions(listing).length === 0
    },

    /** Key for the device pair currently in use, or null until an input is open — there is
     *  nothing to calibrate against until both ends are known. */
    activeCalibrationKey(): string | null {
      const inputName = this.current?.input?.deviceName
      if (!inputName) return null
      return calibrationKey(inputName, useAudioDeviceStore().currentDeviceName)
    },

    /** The stored calibration for the current device pair, or null when uncalibrated. */
    activeCalibration(): LatencyCalibrationDto | null {
      const key = this.activeCalibrationKey
      return key === null ? null : (this.calibrations[key] ?? null)
    },

    /** True when the stored calibration was measured at a different sample rate than the one
     *  now in use. The figure is kept and still used — it is far closer than no calibration —
     *  but the dialog says it is worth measuring again. */
    isCalibrationStale(): boolean {
      const stored = this.activeCalibration
      const rate = this.current?.input?.sampleRate
      if (stored === null || stored.manual || !rate || stored.sampleRate <= 0) return false
      return Math.abs(stored.sampleRate - rate) > 1
    },

    /** What the take is actually being trimmed by when uncalibrated: the drivers' own figure,
     *  which is the number the dialog contrasts a real measurement against. */
    driverLatencyMs(): number {
      return this.current?.input?.inputLatencyMs ?? 0
    }
  },

  actions: {
    /** Open the Record Audio dialog. Hydrating the remembered input first means
     *  the session opens on the user's device rather than switching under them.
     *  An empty driver is legitimate — it means Preferences has not pinned one,
     *  so the backend picks whichever driver offers the device. */
    async openDialog(): Promise<void> {
      // Recording takes the transport over: it parks the playhead on the anchor and
      // starts its own play. Pausing here means that happens from rest, well before
      // Record is pressed, rather than cutting the project off mid-flow at the moment
      // a take begins.
      const transport = useTransportStore()
      if (transport.isPlaying) {
        sendBridge('TRANSPORT_PAUSE')
        transport.setPlaybackState(false)
      }
      const saved = await window.silverdaw.getAudioInput().catch(() => null)
      this.preferredInputTypeName = saved?.typeName ?? null
      this.rememberedInputGainDb = saved?.gainDb ?? 0
      this.rememberedInput = saved?.deviceName
        ? { typeName: saved.typeName ?? '', deviceName: saved.deviceName }
        : null
      await this.loadCalibrations()
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

    /** Show scan progress until the list arrives. */
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
      this.resetCalibrationRun()
    },

    // ─── Latency calibration (ADR 0030, Amendment 17) ──────────────────────

    async loadCalibrations(): Promise<void> {
      this.calibrations = await window.silverdaw.getLatencyCalibrations().catch(() => ({}))
    },

    applyCalibrateState(payload: RecordingCalibrateStatePayload): void {
      this.calibrateStatus = payload.status
      this.calibrateClicksDetected = payload.clicksDetected
      this.calibrateClicksTotal = payload.clicksTotal
      this.calibrateResultMs = payload.status === 'measured' ? payload.roundTripMs : null
      this.calibrateError = payload.error ?? null
    },

    /** Clears the run, not the stored calibration: closing the dialog abandons a measurement
     *  but must never lose a figure the user already accepted. */
    resetCalibrationRun(): void {
      this.calibrateStatus = 'idle'
      this.calibrateClicksDetected = 0
      this.calibrateClicksTotal = 0
      this.calibrateResultMs = null
      this.calibrateError = null
    },

    startCalibration(): void {
      const sessionId = this.activeSessionId
      if (sessionId === null) return
      this.resetCalibrationRun()
      this.calibrateStatus = 'measuring'
      sendBridge('RECORD_CALIBRATE_START', { protocolVersion: RECORDING_PROTOCOL_VERSION, sessionId })
    },

    cancelCalibration(): void {
      sendBridge('RECORD_CALIBRATE_CANCEL', {
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        sessionId: this.activeSessionId ?? ''
      })
      this.resetCalibrationRun()
    },

    /** Stores a round trip for the current device pair and pushes it to the backend, so the
     *  very next take is trimmed by it. `manual` marks a typed figure, which a later
     *  measurement offers to replace rather than silently overwriting. */
    saveCalibration(roundTripMs: number, manual: boolean): void {
      const key = this.activeCalibrationKey
      if (key === null) return
      const entry: LatencyCalibrationDto = {
        roundTripMs,
        manual,
        sampleRate: this.current?.input?.sampleRate ?? 0,
        measuredAt: new Date().toISOString()
      }
      this.calibrations = { ...this.calibrations, [key]: entry }
      window.silverdaw.setLatencyCalibration(key, entry)
      this.pushCalibrationToBackend()
      this.resetCalibrationRun()
    },

    /** Forgets the calibration for this device pair; takes fall back to the drivers' figures. */
    clearCalibration(): void {
      const key = this.activeCalibrationKey
      if (key === null) return
      const next = { ...this.calibrations }
      delete next[key]
      this.calibrations = next
      window.silverdaw.setLatencyCalibration(key, null)
      this.pushCalibrationToBackend()
      this.resetCalibrationRun()
    },

    /** Tells the backend what to trim by. Sent whenever the session or the device pair
     *  changes, because the backend has no access to preferences and would otherwise keep
     *  using a figure belonging to a device that is no longer open. */
    pushCalibrationToBackend(): void {
      const sessionId = this.activeSessionId
      if (sessionId === null) return
      sendBridge('RECORD_SESSION_CONTROL', {
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        sessionId,
        action: 'setCalibration',
        roundTripMs: this.activeCalibration?.roundTripMs ?? null
      })
    }
  }
})
