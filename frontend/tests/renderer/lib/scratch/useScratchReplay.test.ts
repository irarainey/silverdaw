import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { useScratchReplay } from '@/lib/scratch/useScratchReplay'
import type { ScratchPattern, ScratchSessionStatePayload } from '@shared/bridge-protocol'

function makePattern(overrides: Partial<ScratchPattern> = {}): ScratchPattern {
  return {
    id: 'pattern-1',
    name: 'Draft',
    durationUs: 2_000_000,
    cropStartUs: 0,
    cropEndUs: 1_000_000,
    platter: [],
    crossfader: [],
    ...overrides
  } as ScratchPattern
}

function setup(overrides: { canControl?: boolean } = {}) {
  const canControl = ref(overrides.canControl ?? true)
  const sessionState = ref<ScratchSessionStatePayload | null>(null)
  const savedPatterns = ref<readonly ScratchPattern[]>([])
  const startPatternReplay = vi.fn()
  const stopPatternReplay = vi.fn()

  const replay = useScratchReplay({
    canControl,
    sessionState,
    savedPatterns,
    startPatternReplay,
    stopPatternReplay
  })

  return { replay, canControl, sessionState, savedPatterns, startPatternReplay, stopPatternReplay }
}

describe('useScratchReplay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts replay for a resolved pattern object and stops automatically after the crop duration', () => {
    const { replay, startPatternReplay, stopPatternReplay } = setup()
    const pattern = makePattern()

    replay.startReplay(pattern)
    expect(startPatternReplay).toHaveBeenCalledWith(pattern)
    expect(replay.isPatternReplaying.value).toBe(true)

    vi.advanceTimersByTime(1_000 + 49)
    expect(stopPatternReplay).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(stopPatternReplay).toHaveBeenCalledTimes(1)
    expect(replay.isPatternReplaying.value).toBe(false)
  })

  it('resolves a saved-pattern id from savedPatterns before starting replay', () => {
    const { replay, savedPatterns, startPatternReplay } = setup()
    const pattern = makePattern({ id: 'saved-1' })
    savedPatterns.value = [pattern]

    replay.startReplay('saved-1')
    expect(startPatternReplay).toHaveBeenCalledWith('saved-1')
    expect(replay.isPatternReplaying.value).toBe(true)
  })

  it('does nothing when a saved-pattern id cannot be resolved', () => {
    const { replay, startPatternReplay } = setup()
    replay.startReplay('missing-id')
    expect(startPatternReplay).not.toHaveBeenCalled()
    expect(replay.isPatternReplaying.value).toBe(false)
  })

  it('stopReplay clears the pending timer and only calls stopPatternReplay while replaying', () => {
    const { replay, stopPatternReplay } = setup()
    replay.stopReplay()
    expect(stopPatternReplay).not.toHaveBeenCalled()

    replay.startReplay(makePattern())
    replay.stopReplay()
    expect(stopPatternReplay).toHaveBeenCalledTimes(1)
    expect(replay.isPatternReplaying.value).toBe(false)

    // The auto-stop timer from the first startReplay must not fire late.
    vi.advanceTimersByTime(5_000)
    expect(stopPatternReplay).toHaveBeenCalledTimes(1)
  })

  it('gates controlsEnabled off during replay regardless of canControl', () => {
    const { replay, canControl } = setup({ canControl: true })
    expect(replay.controlsEnabled.value).toBe(true)
    replay.startReplay(makePattern())
    expect(replay.controlsEnabled.value).toBe(false)
    replay.stopReplay()
    expect(replay.controlsEnabled.value).toBe(true)

    canControl.value = false
    expect(replay.controlsEnabled.value).toBe(false)
  })

  it('exposes the notation replay position only while replaying', () => {
    const { replay, sessionState } = setup()
    sessionState.value = { replayPositionNormalized: 0.5 } as ScratchSessionStatePayload
    expect(replay.notationReplayPositionNormalized.value).toBe(null)

    replay.startReplay(makePattern())
    expect(replay.notationReplayPositionNormalized.value).toBe(0.5)

    replay.stopReplay()
    expect(replay.notationReplayPositionNormalized.value).toBe(null)
  })
})
