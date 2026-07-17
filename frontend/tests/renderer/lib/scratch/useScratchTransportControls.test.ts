import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useScratchTransportControls } from '@/lib/scratch/useScratchTransportControls'

function setup(overrides: {
  activeSessionId?: string | null
  canControl?: boolean
  backingReady?: boolean
  isRecording?: boolean
  isPatternReplaying?: boolean
} = {}) {
  const activeSessionId = ref(overrides.activeSessionId ?? 'sid-1')
  const canControl = ref(overrides.canControl ?? true)
  const backingReady = ref(overrides.backingReady ?? true)
  const isRecording = ref(overrides.isRecording ?? false)
  const isPatternReplaying = ref(overrides.isPatternReplaying ?? false)
  const togglePlayback = vi.fn()
  const sendControl = vi.fn()

  const transport = useScratchTransportControls({
    activeSessionId,
    canControl,
    backingReady,
    isRecording,
    isPatternReplaying,
    togglePlayback,
    sendControl
  })

  return {
    transport,
    activeSessionId,
    canControl,
    backingReady,
    isRecording,
    isPatternReplaying,
    togglePlayback,
    sendControl
  }
}

describe('useScratchTransportControls', () => {
  it('is enabled only when controllable, backing is ready, and neither recording nor replaying', () => {
    expect(setup().transport.transportEnabled.value).toBe(true)
    expect(setup({ canControl: false }).transport.transportEnabled.value).toBe(false)
    expect(setup({ backingReady: false }).transport.transportEnabled.value).toBe(false)
    expect(setup({ isRecording: true }).transport.transportEnabled.value).toBe(false)
    expect(setup({ isPatternReplaying: true }).transport.transportEnabled.value).toBe(false)
  })

  it('skip-to-start sends a seek-to-zero payload only when transport is enabled', () => {
    const { transport, sendControl } = setup()
    transport.onSkipToStart()
    expect(sendControl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sid-1', action: 'seek', positionUs: 0 })
    )

    const disabled = setup({ isRecording: true })
    disabled.transport.onSkipToStart()
    expect(disabled.sendControl).not.toHaveBeenCalled()
  })

  it('toggle-play does nothing while scratch replay has disabled the backing transport', () => {
    const { transport, togglePlayback } = setup({ isPatternReplaying: true })
    transport.onTogglePlay()
    expect(togglePlayback).not.toHaveBeenCalled()
  })

  it('toggle-play runs the backing transport when enabled', () => {
    const { transport, togglePlayback } = setup()
    transport.onTogglePlay()
    expect(togglePlayback).toHaveBeenCalledTimes(1)
  })

  it('toggle-play does nothing when transport is disabled', () => {
    const { transport, togglePlayback } = setup({ backingReady: false })
    transport.onTogglePlay()
    expect(togglePlayback).not.toHaveBeenCalled()
  })
})
