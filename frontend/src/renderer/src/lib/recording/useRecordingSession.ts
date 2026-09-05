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
  type RecordingSessionControlPayload,
  type RecordingWindowMode
} from '@shared/bridge-protocol'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
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
  /** Input gain in dB; changeable while rolling, so a clipping performer can fix
   *  it without losing the take. */
  setInputGain(gainDb: number): void
  setWindowMode(mode: RecordingWindowMode): void
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
  const transport = useTransportStore()

  function requestInputs(refresh: boolean): void {
    if (refresh) store.beginInputRescan()
    const sent = sendBridge('RECORD_INPUTS_REQUEST', refresh ? { refresh: true } : {})
    if (!sent && refresh) store.finishInputRescan()
  }

  function openSession(): void {
    store.clear()
    const input = store.rememberedInput
    // The device list is cached across opens — enumerating every driver is slow
    // enough to be felt, and Rescan is there for when the hardware changes.
    if (store.inputs === null) requestInputs(false)
    sendBridge('RECORD_SESSION_OPEN', {
      protocolVersion: RECORDING_PROTOCOL_VERSION,
      ...(input ? { input } : {})
    })
  }

  function closeSession(): void {
    const sessionId = store.activeSessionId
    if (sessionId !== null) {
      store.noteClosed(sessionId)
      sendBridge('RECORD_SESSION_CLOSE', {
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        sessionId
      })
    }
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

  // A new session starts at unity, so the remembered level is re-applied as soon
  // as there is a session to apply it to. The gain belongs to the setup, not to
  // one take, so it must survive the dialog closing.
  watch(
    () => store.activeSessionId,
    (sessionId) => {
      if (sessionId === null || !open.value) return
      if (store.rememberedInputGainDb === 0) return
      const base = withSession('setInputGain')
      if (base) control({ ...base, gainDb: store.rememberedInputGainDb })
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
      const base = withSession('setCountInBars')
      if (base) control({ ...base, bars })
    },

    setClickEnabled(enabled: boolean): void {
      const base = withSession('setClickEnabled')
      if (base) control({ ...base, enabled })
    },

    setWindowMode(mode: RecordingWindowMode): void {
      const base = withSession('setWindowMode')
      if (base) control({ ...base, mode })
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
