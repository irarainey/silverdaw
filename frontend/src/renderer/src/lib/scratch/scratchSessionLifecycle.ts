import { ref, type Ref } from 'vue'
import {
  SCRATCH_PROTOCOL_VERSION,
  type ScratchSessionClosePayload,
  type ScratchSessionControlPayload,
  type ScratchSessionOpenPayload,
  type ScratchSessionStatePayload
} from '@shared/bridge-protocol'

interface ScratchSessionLifecycleDependencies {
  open(payload: ScratchSessionOpenPayload): void
  close(payload: ScratchSessionClosePayload): void
  control(payload: ScratchSessionControlPayload): void
  clearState(): void
}

export interface ScratchSessionLifecycle {
  activeSessionId: Ref<string | null>
  state: Ref<ScratchSessionStatePayload | null>
  open(clipId: string): void
  consume(payload: ScratchSessionStatePayload): void
  close(): void
  clearStaleOnRecovery(): void
  togglePlayback(): void
  toggleRecording(): void
  sendControl(payload: ScratchSessionControlPayload): void
}

export function createScratchSessionLifecycle(
  dependencies: ScratchSessionLifecycleDependencies
): ScratchSessionLifecycle {
  const activeSessionId = ref<string | null>(null)
  const state = ref<ScratchSessionStatePayload | null>(null)
  const closedSessionIds = new Set<string>()
  let targetClipId: string | null = null

  function closeSession(sessionId: string): void {
    if (closedSessionIds.has(sessionId)) return
    closedSessionIds.add(sessionId)
    dependencies.close({ protocolVersion: SCRATCH_PROTOCOL_VERSION, sessionId })
  }

  function clear(): void {
    activeSessionId.value = null
    state.value = null
    dependencies.clearState()
  }

  function open(clipId: string): void {
    if (activeSessionId.value) closeSession(activeSessionId.value)
    clear()
    targetClipId = clipId
    dependencies.open({ protocolVersion: SCRATCH_PROTOCOL_VERSION, clipId })
  }

  function consume(payload: ScratchSessionStatePayload): void {
    const isStale =
      targetClipId === null ||
      payload.clipId !== targetClipId ||
      closedSessionIds.has(payload.sessionId) ||
      (activeSessionId.value !== null && payload.sessionId !== activeSessionId.value)

    if (isStale) {
      closeSession(payload.sessionId)
      dependencies.clearState()
      return
    }

    activeSessionId.value = payload.sessionId
    state.value = payload
  }

  // Clear stale session state during engine recovery without sending close
  // (the backend session is already gone).
  function clearStaleOnRecovery(): void {
    if (activeSessionId.value) closedSessionIds.add(activeSessionId.value)
    activeSessionId.value = null
    state.value = null
    dependencies.clearState()
  }

  function close(): void {
    targetClipId = null
    if (activeSessionId.value) closeSession(activeSessionId.value)
    clear()
  }

  function togglePlayback(): void {
    const sessionId = activeSessionId.value
    if (!sessionId) return
    dependencies.control({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      sessionId,
      action: state.value?.status === 'playing' ? 'pause' : 'play'
    })
  }

  function sendControl(payload: ScratchSessionControlPayload): void {
    dependencies.control(payload)
  }

  function toggleRecording(): void {
    const sessionId = activeSessionId.value
    if (!sessionId) return
    dependencies.control({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      sessionId,
      action: state.value?.status === 'recording' ? 'recordStop' : 'recordStart'
    })
  }

  return { activeSessionId, state, open, consume, close, clearStaleOnRecovery, togglePlayback, toggleRecording, sendControl }
}
