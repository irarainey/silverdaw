// Lifecycle for the Record Audio dialog's backend session (ADR 0030).
//
// The backend session owns the capture device, so it is opened when the dialog
// opens and closed when it closes — including on unmount and on engine
// recovery, so an abandoned dialog can never leave a microphone held open.
// Nothing here holds audio: the store mirrors RECORD_SESSION_STATE and the
// finished recording is only ever referenced by path.

import { computed, getCurrentScope, onScopeDispose, watch, type ComputedRef, type Ref } from 'vue'
import {
  MAX_RECORDING_INPUT_GAIN_DB,
  MIN_RECORDING_INPUT_GAIN_DB,
  RECORDING_PROTOCOL_VERSION,
  type RecordingChannelCount,
  type RecordingCountInBars,
  type RecordingInputSelection,
  type RecordingMode,
  type RecordingSessionControlPayload,
  type RecordingWindowMode
} from '@shared/bridge-protocol'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useProjectStore } from '@/stores/projectStore'
import { useRecordingSessionStore } from '@/stores/recordingSessionStore'
import { useTransportStore } from '@/stores/transportStore'

export interface RecordingCommitRequest {
  name: string
  destination: 'library' | 'timeline'
  /** Destination track for `timeline`; omitting it lets the backend resolve the
   *  selected track, or append a new one. */
  trackId?: string
}

export interface RecordingSession {
  /** True once the backend has answered with a session to control. */
  ready: ComputedRef<boolean>
  selectInput(input: RecordingInputSelection): void
  /** Re-enumerate capture devices. The list is cached, so this is the only way a
   *  device plugged in since the last scan appears. */
  rescanInputs(): void
  selectChannels(firstChannel: number, channelCount: RecordingChannelCount): void
  setCountInBars(bars: RecordingCountInBars): void
  /** Whether the click carries on through the take. Kept to the session: the
   *  timeline's own metronome is left exactly as it was found. */
  setClickEnabled(enabled: boolean): void
  /** Which tracks are heard while recording. Engine-only and borrowed in both
   *  directions — a muted track can be brought in for a take — and audibility
   *  goes back to the project when the dialog closes. */
  setBackingTracks(trackIds: readonly string[]): void
  /** How loud the backing plays under the performer, 0..1. Monitoring only: it
   *  trims the arrangement in the engine and never touches the project's master
   *  volume, so the timeline sounds unchanged once the dialog closes. */
  setBackingGain(gain: number): void
  /** How loud the arrangement plays under the take being reviewed, 0..1. Held
   *  apart from `setBackingGain`, and applied on entering review and given back
   *  on leaving it, so a quiet guide mix is not also how the take is heard back. */
  setReviewBackingGain(gain: number): void
  /** Put the setup's backing level back after a review. */
  restoreBackingGain(): void
  /** Input gain in dB; changeable while rolling, so a clipping performer can fix
   *  it without losing the take. */
  setInputGain(gainDb: number): void
  setWindowMode(mode: RecordingWindowMode): void
  /** Whether the take is committed as musical material or a plain sample. It is
   *  read at commit, so it can be changed right up to keeping the take. */
  setRecordingMode(mode: RecordingMode): void
  /** Whether the performer hears their own input in the monitor mix. Opt-in:
   *  with speakers rather than headphones it is a feedback loop. */
  setMonitorEnabled(enabled: boolean): void
  /** Whether the finished take gets the noise-reduction pass at finalise. */
  setCleanupEnabled(enabled: boolean): void
  /** Whether a mono take is saved as a stereo file with the capture on both
   *  sides. Applied to the take itself before it is saved, so the review
   *  auditions what will be kept. Ignored for a stereo capture. */
  setStereoDuplicated(enabled: boolean): void
  start(): void
  stop(): void
  /** Record Again: throws the finished file away without creating anything. */
  discard(): void
  /** Commit the finished recording; returns the library item id it will carry,
   *  or null when there is nothing to commit. */
  commit(request: RecordingCommitRequest): string | null
}

type ControlBase<T extends RecordingSessionControlPayload['action']> = {
  protocolVersion: typeof RECORDING_PROTOCOL_VERSION
  sessionId: string
  action: T
}

export function useRecordingSession(open: Ref<boolean>): RecordingSession {
  const store = useRecordingSessionStore()
  const project = useProjectStore()
  const transport = useTransportStore()

  function requestInputs(refresh: boolean): void {
    store.beginInputRescan()
    const sent = sendBridge('RECORD_INPUTS_REQUEST', refresh ? { refresh: true } : {})
    if (!sent) store.finishInputRescan()
  }

  function openSession(): void {
    store.clear()
    const input = store.rememberedInput
    // Session open goes first, and deliberately so. Enumerating every driver type
    // costs hundreds of milliseconds on the backend's message thread, and every
    // control in the dialog reads from the session state — so asking for the
    // device list first parks the whole form behind a scan it does not need. The
    // list fills one dropdown; the session fills the rest of the dialog.
    sendBridge('RECORD_SESSION_OPEN', {
      protocolVersion: RECORDING_PROTOCOL_VERSION,
      ...(input ? { input } : {})
    })
    // The device list is cached across opens — enumerating every driver is slow
    // enough to be felt, and Rescan is there for when the hardware changes.
    if (store.inputs === null) requestInputs(false)
  }

  function closeSession(): void {
    const sessionId = store.activeSessionId
    if (sessionId !== null) store.noteClosed(sessionId)
    // Sent even with no adopted id: the backend reads '' as "whichever session is
    // open", which is what hands the click, backing, loop and monitor back when
    // the dialog closes before it ever saw a state broadcast.
    sendBridge('RECORD_SESSION_CLOSE', {
      protocolVersion: RECORDING_PROTOCOL_VERSION,
      sessionId: sessionId ?? ''
    })
    store.clear()
  }

  function control(payload: RecordingSessionControlPayload): void {
    sendBridge('RECORD_SESSION_CONTROL', payload)
  }

  /** Control-payload preamble for the open session, or null when there is none. */
  function withSession<T extends RecordingSessionControlPayload['action']>(
    action: T
  ): ControlBase<T> | null {
    const sessionId = store.activeSessionId
    if (sessionId === null) return null
    return { protocolVersion: RECORDING_PROTOCOL_VERSION, sessionId, action }
  }

  watch(
    open,
    (isOpen, wasOpen) => {
      if (isOpen && !wasOpen) openSession()
      else if (!isOpen && wasOpen) closeSession()
    },
    { immediate: true }
  )

  // A fresh session starts from the backend's own seeds, so anything the user
  // chose in this app session is re-applied as soon as there is a session to
  // apply it to. These settings belong to how the user is working — the take
  // they are chasing — not to one session, so they must survive the dialog
  // closing. Anything untouched (null) keeps the backend's seed.
  watch(
    () => store.activeSessionId,
    (sessionId) => {
      if (sessionId === null || !open.value) return
      if (store.rememberedInputGainDb !== 0) {
        const base = withSession('setInputGain')
        if (base) control({ ...base, gainDb: store.rememberedInputGainDb })
      }
      if (store.rememberedWindowMode !== null) {
        // A selection-scoped window is only meaningful while a selection exists;
        // the backend falls back to the playhead when it does not.
        const base = withSession('setWindowMode')
        if (base) control({ ...base, mode: store.rememberedWindowMode })
      }
      if (store.rememberedCountInBars !== null) {
        const base = withSession('setCountInBars')
        if (base) control({ ...base, bars: store.rememberedCountInBars })
      }
      if (store.rememberedClickEnabled !== null) {
        const base = withSession('setClickEnabled')
        if (base) control({ ...base, enabled: store.rememberedClickEnabled })
      }
      if (store.rememberedBackingGain !== null) {
        const base = withSession('setBackingGain')
        if (base) control({ ...base, gain: store.rememberedBackingGain })
      }
      if (store.rememberedRecordingMode !== null) {
        const base = withSession('setRecordingMode')
        if (base) control({ ...base, mode: store.rememberedRecordingMode })
      }
      if (store.rememberedMonitorEnabled !== null) {
        const base = withSession('setMonitorEnabled')
        if (base) control({ ...base, enabled: store.rememberedMonitorEnabled })
      }
      if (store.rememberedCleanupEnabled !== null) {
        const base = withSession('setCleanupEnabled')
        if (base) control({ ...base, enabled: store.rememberedCleanupEnabled })
      }
      if (store.rememberedBackingTrackIds !== null) {
        // Ids of tracks deleted since the last open are dropped by the backend.
        // A remembered selection whose tracks are all gone means a different
        // project is open, so the backend's seed — what the timeline is playing
        // — is the better answer than silence.
        const remembered = store.rememberedBackingTrackIds
        const present = new Set(project.tracks.map((track) => track.id))
        const stillHere = remembered.filter((trackId) => present.has(trackId))
        if (remembered.length === 0 || stillHere.length > 0) {
          const base = withSession('setBackingTracks')
          if (base) control({ ...base, trackIds: stillHere })
        }
      }
    }
  )

  // Persist whatever the user sets, rather than watching the session state back:
  // the state also carries the unity gain a fresh session starts at, which would
  // race the re-apply above and wipe the remembered level. See `setInputGain`.

  // A session whose first state arrives after the dialog has gone (the user
  // closed it before the backend answered) still holds the capture device.
  watch(
    () => store.activeSessionId,
    (sessionId) => {
      if (sessionId === null || open.value) return
      log.info('recording', `closing orphaned session ${sessionId}`)
      closeSession()
    }
  )

  // Engine recovery destroys the backend session; reopen rather than leaving the
  // dialog wired to a session that no longer exists.
  let wasRecovering = false
  watch(
    () => transport.engineRecovery,
    (phase) => {
      if (phase === 'recovering' || phase === 'restoring') {
        wasRecovering = true
        // The backend session is already gone, so clear without sending a close —
        // but remember it, or a state message still in flight would revive it.
        const sessionId = store.activeSessionId
        if (sessionId !== null) store.noteClosed(sessionId)
        store.clear()
        return
      }
      if (phase === 'ok' && wasRecovering) {
        wasRecovering = false
        if (open.value) openSession()
      }
    }
  )

  // Remember the device the session actually resolved to, not the one that was
  // asked for: a device that failed to open must not come back next time. Only
  // the device is written — the driver is a Preferences choice and is preserved.
  watch(
    () => store.current?.input ?? null,
    (input) => {
      if (input === null) return
      const selection: RecordingInputSelection = {
        typeName: input.typeName,
        deviceName: input.deviceName
      }
      if (store.rememberedInput?.deviceName === selection.deviceName) return
      store.setRememberedInput(selection)
      void window.silverdaw.setAudioInput({
        typeName: store.preferredInputTypeName,
        deviceName: selection.deviceName
      })
    }
  )

  // Unmounting the dialog must release the capture device just as closing it does.
  if (getCurrentScope()) onScopeDispose(closeSession)

  return {
    ready: computed(() => store.activeSessionId !== null),

    selectInput(input: RecordingInputSelection): void {
      const base = withSession('selectInput')
      if (base) control({ ...base, input })
    },

    rescanInputs(): void {
      if (store.rescanningInputs) return
      requestInputs(true)
    },

    selectChannels(firstChannel: number, channelCount: RecordingChannelCount): void {
      const base = withSession('selectChannels')
      if (base) control({ ...base, firstChannel, channelCount })
    },

    setCountInBars(bars: RecordingCountInBars): void {
      store.rememberedCountInBars = bars
      const base = withSession('setCountInBars')
      if (base) control({ ...base, bars })
    },

    setClickEnabled(enabled: boolean): void {
      store.rememberedClickEnabled = enabled
      const base = withSession('setClickEnabled')
      if (base) control({ ...base, enabled })
    },

    setBackingTracks(trackIds: readonly string[]): void {
      store.rememberedBackingTrackIds = [...trackIds]
      const base = withSession('setBackingTracks')
      if (base) control({ ...base, trackIds: [...trackIds] })
    },

    setBackingGain(gain: number): void {
      const clamped = Math.min(1, Math.max(0, gain))
      store.rememberedBackingGain = clamped
      const base = withSession('setBackingGain')
      if (base) control({ ...base, gain: clamped })
    },

    setReviewBackingGain(gain: number): void {
      const clamped = Math.min(1, Math.max(0, gain))
      store.rememberedReviewBackingGain = clamped
      const base = withSession('setBackingGain')
      if (base) control({ ...base, gain: clamped })
    },

    restoreBackingGain(): void {
      // Null means the setup slider was never touched, so the session opened at
      // the backend's own unity seed and that is what to go back to.
      const base = withSession('setBackingGain')
      if (base) control({ ...base, gain: store.rememberedBackingGain ?? 1 })
    },

    setWindowMode(mode: RecordingWindowMode): void {
      store.rememberedWindowMode = mode
      const base = withSession('setWindowMode')
      if (base) control({ ...base, mode })
    },

    setRecordingMode(mode: RecordingMode): void {
      store.rememberedRecordingMode = mode
      const base = withSession('setRecordingMode')
      if (base) control({ ...base, mode })
    },

    setMonitorEnabled(enabled: boolean): void {
      store.rememberedMonitorEnabled = enabled
      const base = withSession('setMonitorEnabled')
      if (base) control({ ...base, enabled })
    },

    setCleanupEnabled(enabled: boolean): void {
      store.rememberedCleanupEnabled = enabled
      const base = withSession('setCleanupEnabled')
      if (base) control({ ...base, enabled })
    },

    setStereoDuplicated(enabled: boolean): void {
      store.rememberedStereoDuplicated = enabled
      const sessionId = store.activeSessionId
      const recordingId = store.ready?.recordingId
      if (sessionId === null || !recordingId) return
      sendBridge('RECORD_RECORDING_SET_STEREO', {
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        sessionId,
        recordingId,
        enabled
      })
    },

    setInputGain(gainDb: number): void {
      const clamped = Math.min(
        MAX_RECORDING_INPUT_GAIN_DB,
        Math.max(MIN_RECORDING_INPUT_GAIN_DB, gainDb)
      )
      const base = withSession('setInputGain')
      if (base) control({ ...base, gainDb: clamped })
      if (clamped === store.rememberedInputGainDb) return
      store.rememberedInputGainDb = clamped
      window.silverdaw.setAudioInput({ gainDb: clamped })
    },

    start(): void {
      const base = withSession('start')
      if (base) control(base)
    },

    stop(): void {
      const base = withSession('stop')
      if (base) control(base)
    },

    discard(): void {
      const base = withSession('discard')
      if (base) control(base)
    },

    commit(request: RecordingCommitRequest): string | null {
      const sessionId = store.activeSessionId
      const ready = store.ready
      // One commit at a time: a second would create a second library item and
      // orphan the first ack.
      if (sessionId === null || ready === null || store.commitPendingItemId !== null) return null
      const itemId = `recording-${crypto.randomUUID()}`
      store.beginCommit(itemId)
      sendBridge('RECORD_RECORDING_COMMIT', {
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        sessionId,
        recordingId: ready.recordingId,
        itemId,
        name: request.name,
        destination: request.destination,
        ...(request.trackId ? { trackId: request.trackId } : {}),
        ...(request.destination === 'timeline' ? { clipId: crypto.randomUUID() } : {})
      })
      return itemId
    }
  }
}
