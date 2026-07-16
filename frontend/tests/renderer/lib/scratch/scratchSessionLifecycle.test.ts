import { describe, expect, it, vi } from 'vitest'
import {
  createScratchSessionLifecycle
} from '@/lib/scratch/scratchSessionLifecycle'
import type {
  ScratchSessionClosePayload,
  ScratchSessionControlPayload,
  ScratchSessionOpenPayload,
  ScratchSessionStatePayload
} from '@shared/bridge-protocol'

function makeState(
  overrides: Partial<ScratchSessionStatePayload> = {}
): ScratchSessionStatePayload {
  return {
    protocolVersion: 1,
    sessionId: 'session-1',
    clipId: 'clip-1',
    status: 'preparing',
    positionUs: 0,
    durationUs: 0,
    platterTurns: 0,
    playbackRate: 0,
    crossfader: 0.5,
    ownerDeviceIdentifier: null,
    ownerDeck: null,
    touched: false,
    ...overrides
  }
}

function setup() {
  const open = vi.fn<(payload: ScratchSessionOpenPayload) => void>()
  const close = vi.fn<(payload: ScratchSessionClosePayload) => void>()
  const control = vi.fn<(payload: ScratchSessionControlPayload) => void>()
  const clearState = vi.fn()
  return {
    lifecycle: createScratchSessionLifecycle({ open, close, control, clearState }),
    open,
    close,
    control,
    clearState
  }
}

describe('scratch session lifecycle', () => {
  it('opens with protocol version 1 and closes only after receiving a session id', () => {
    const { lifecycle, open, close, clearState } = setup()
    lifecycle.open('clip-1')
    expect(open).toHaveBeenCalledWith({ protocolVersion: 1, clipId: 'clip-1' })

    lifecycle.close()
    expect(close).not.toHaveBeenCalled()
    expect(clearState).toHaveBeenCalled()

    lifecycle.open('clip-1')
    lifecycle.consume(makeState())
    lifecycle.close()
    expect(close).toHaveBeenCalledWith({ protocolVersion: 1, sessionId: 'session-1' })
  })

  it('closes a session reply that arrives after the editor closed during preparation', () => {
    const { lifecycle, close, clearState } = setup()
    lifecycle.open('clip-1')
    lifecycle.close()
    lifecycle.consume(makeState({ status: 'preparing' }))

    expect(close).toHaveBeenCalledWith({ protocolVersion: 1, sessionId: 'session-1' })
    expect(lifecycle.activeSessionId.value).toBe(null)
    expect(clearState).toHaveBeenCalled()
  })

  it('rejects stale replies without replacing the active session', () => {
    const { lifecycle, close } = setup()
    lifecycle.open('clip-1')
    lifecycle.consume(makeState())
    lifecycle.consume(makeState({ sessionId: 'stale-session', clipId: 'other-clip' }))

    expect(close).toHaveBeenCalledWith({ protocolVersion: 1, sessionId: 'stale-session' })
    expect(lifecycle.activeSessionId.value).toBe('session-1')
  })

  it('dispatches local play and pause against the active backend session', () => {
    const { lifecycle, control } = setup()
    lifecycle.open('clip-1')
    lifecycle.consume(makeState({ status: 'ready' }))
    lifecycle.togglePlayback()
    expect(control).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      sessionId: 'session-1',
      action: 'play'
    })

    lifecycle.consume(makeState({ status: 'playing' }))
    lifecycle.togglePlayback()
    expect(control).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      sessionId: 'session-1',
      action: 'pause'
    })
  })

  it('race: old session A arriving after active session B is rejected and closed', () => {
    const { lifecycle, close, clearState } = setup()
    lifecycle.open('clip-1')
    lifecycle.consume(makeState({ sessionId: 'session-B', clipId: 'clip-1', status: 'ready' }))
    expect(lifecycle.activeSessionId.value).toBe('session-B')

    // Delayed state from old session A arrives
    lifecycle.consume(makeState({ sessionId: 'session-A', clipId: 'clip-old', status: 'paused' }))
    expect(close).toHaveBeenCalledWith({ protocolVersion: 1, sessionId: 'session-A' })
    expect(lifecycle.activeSessionId.value).toBe('session-B')
    expect(clearState).toHaveBeenCalled()
  })

  it('race: stale session arriving after close does not re-activate', () => {
    const { lifecycle, close } = setup()
    lifecycle.open('clip-1')
    lifecycle.consume(makeState({ sessionId: 'session-1', status: 'ready' }))
    lifecycle.close()

    // A delayed state from session-1 arrives after close
    lifecycle.consume(makeState({ sessionId: 'session-1', status: 'playing' }))
    expect(close).toHaveBeenCalledWith({ protocolVersion: 1, sessionId: 'session-1' })
    expect(lifecycle.activeSessionId.value).toBe(null)
  })

  it('clearStaleOnRecovery prevents subsequent state from the same session', () => {
    const { lifecycle, clearState } = setup()
    lifecycle.open('clip-1')
    lifecycle.consume(makeState({ sessionId: 'session-1', status: 'ready' }))
    lifecycle.clearStaleOnRecovery()
    expect(lifecycle.activeSessionId.value).toBe(null)

    // State from the old session arrives after recovery
    lifecycle.consume(makeState({ sessionId: 'session-1', status: 'playing' }))
    expect(lifecycle.activeSessionId.value).toBe(null)
    expect(clearState).toHaveBeenCalled()
  })

  it('supports repeated play-end-restart cycles without deactivation', () => {
    const { lifecycle, control } = setup()
    lifecycle.open('clip-1')
    lifecycle.consume(makeState({ sessionId: 'session-1', status: 'ready' }))

    for (let cycle = 0; cycle < 5; cycle++) {
      // Play
      lifecycle.togglePlayback()
      expect(control).toHaveBeenLastCalledWith({
        protocolVersion: 1,
        sessionId: 'session-1',
        action: 'play'
      })

      // Backend confirms playing
      lifecycle.consume(makeState({ sessionId: 'session-1', status: 'playing', clipId: 'clip-1' }))
      expect(lifecycle.state.value?.status).toBe('playing')

      // Source ends — backend resets to ready at position 0
      lifecycle.consume(
        makeState({ sessionId: 'session-1', status: 'ready', clipId: 'clip-1', positionUs: 0 })
      )
      expect(lifecycle.state.value?.status).toBe('ready')
      expect(lifecycle.state.value?.positionUs).toBe(0)
      expect(lifecycle.activeSessionId.value).toBe('session-1')
    }
  })

  it('end state resets position to start for fresh replay', () => {
    const { lifecycle } = setup()
    lifecycle.open('clip-1')
    lifecycle.consume(makeState({ sessionId: 'session-1', status: 'ready' }))

    // Simulate play reaching end → backend resets to start
    lifecycle.consume(
      makeState({ sessionId: 'session-1', status: 'playing', positionUs: 500_000, clipId: 'clip-1' })
    )
    lifecycle.consume(
      makeState({ sessionId: 'session-1', status: 'ready', positionUs: 0, clipId: 'clip-1' })
    )
    expect(lifecycle.state.value?.positionUs).toBe(0)
    expect(lifecycle.state.value?.status).toBe('ready')
  })
})
