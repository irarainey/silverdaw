import { describe, expect, it, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import type { ScratchPattern, ScratchSessionStatePayload } from '@shared/bridge-protocol'
import { SCRATCH_PATTERN_VERSION, SCRATCH_CROSSFADER_CURVE_VERSION } from '@shared/bridge-protocol'

function makeState(overrides: Partial<ScratchSessionStatePayload> = {}): ScratchSessionStatePayload {
  return {
    protocolVersion: 1,
    sessionId: 'session-1',
    clipId: 'clip-1',
    status: 'ready',
    positionUs: 0,
    durationUs: 2_000_000,
    platterTurns: 0,
    playbackRate: 0,
    crossfader: 0.5,
    ownerDeviceIdentifier: null,
    ownerDeck: null,
    touched: false,
    ...overrides
  }
}

function makePattern(overrides: Partial<ScratchPattern> = {}): ScratchPattern {
  return {
    id: 'pat-1',
    name: 'Test',
    version: SCRATCH_PATTERN_VERSION,
    durationUs: 1_000_000,
    cropStartUs: 0,
    cropEndUs: 1_000_000,
    sourceOffsetTurns: 0,
    ownerDeck: 1,
    crossfaderCurve: SCRATCH_CROSSFADER_CURVE_VERSION,
    platter: [
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 1_000_000, turns: 1, touched: false }
    ],
    crossfader: [
      { timeUs: 0, value: 0 },
      { timeUs: 1_000_000, value: 1 }
    ],
    ...overrides
  }
}

describe('scratchSessionStore editing actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('replacePattern succeeds with valid pattern when session active', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState())
    const p = makePattern()
    expect(store.replacePattern(p)).toBe(true)
    expect(store.completedPattern).toEqual(p)
  })

  it('replacePattern rejects without active session', () => {
    const store = useScratchSessionStore()
    expect(store.replacePattern(makePattern())).toBe(false)
  })

  it('replacePattern rejects invalid pattern', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState())
    const bad = makePattern()
    bad.platter = []
    expect(store.replacePattern(bad)).toBe(false)
  })

  it('editPattern requires matching session ID', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ sessionId: 'session-1' }))
    const p = makePattern()
    expect(store.editPattern('session-1', p)).toBe(true)
    expect(store.editPattern('wrong-id', p)).toBe(false)
  })

  it('editPattern rejects invalid pattern', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState())
    const bad = makePattern()
    bad.platter[0] = { timeUs: 5, turns: 0, touched: true }
    expect(store.editPattern('session-1', bad)).toBe(false)
    expect(store.completedPattern).toBeNull()
  })

  it('isActiveSession checks correctly', () => {
    const store = useScratchSessionStore()
    expect(store.isActiveSession('session-1')).toBe(false)
    store.applyState(makeState({ sessionId: 'session-1' }))
    expect(store.isActiveSession('session-1')).toBe(true)
    expect(store.isActiveSession('other')).toBe(false)
  })

  it('hasEditablePattern is true only when both state and pattern present', () => {
    const store = useScratchSessionStore()
    expect(store.hasEditablePattern).toBe(false)
    store.applyState(makeState())
    expect(store.hasEditablePattern).toBe(false)
    store.completedPattern = makePattern()
    expect(store.hasEditablePattern).toBe(true)
  })

  it('draftRevision increments on edit/replace', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState())
    const initial = store.draftRevision
    store.replacePattern(makePattern())
    expect(store.draftRevision).toBe(initial + 1)
    store.editPattern('session-1', makePattern({ id: 'pat-2' }))
    expect(store.draftRevision).toBe(initial + 2)
  })

  it('clear resets draftRevision to 0', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState())
    store.replacePattern(makePattern())
    store.clear()
    expect(store.draftRevision).toBe(0)
    expect(store.completedPattern).toBeNull()
  })

  it('applyState rejects state for a different session when one is already active', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ sessionId: 'session-A' }))
    // Now a stale session B arrives — should not overwrite A.
    store.applyState(makeState({ sessionId: 'session-B', clipId: 'clip-B' }))
    expect(store.current?.sessionId).toBe('session-A')
    expect(store.current?.clipId).toBe('clip-1')
  })

  it('applyState accepts preparing state when no active session (first ID acceptance)', () => {
    const store = useScratchSessionStore()
    // No active session yet — accept the first preparing state.
    store.applyState(makeState({ sessionId: 'session-new', status: 'preparing' }))
    expect(store.current?.sessionId).toBe('session-new')
    expect(store.current?.status).toBe('preparing')
  })

  it('applyState accepts same session updates (e.g. status transition)', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ sessionId: 'session-1', status: 'preparing' }))
    store.applyState(makeState({ sessionId: 'session-1', status: 'ready' }))
    expect(store.current?.status).toBe('ready')
  })

  it('keeps source peaks scoped to the active scratch session', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ sessionId: 'session-current' }))
    const peaks = new Float32Array([-0.5, 0.75])
    store.setSourcePeaks({
      sessionId: 'session-current',
      peaks,
      channels: [],
      peaksPerSecond: 500,
      sampleRate: 48_000
    })
    store.setSourcePeaks({
      sessionId: 'session-stale',
      peaks: new Float32Array([0, 0]),
      channels: [],
      peaksPerSecond: 500,
      sampleRate: 48_000
    })

    expect(store.sourcePeaks?.peaks).toBe(peaks)
    store.clear()
    expect(store.sourcePeaks).toBeNull()
  })

  it('race: delayed closed session A does not replace active session B', () => {
    const store = useScratchSessionStore()
    // Session B is active
    store.applyState(makeState({ sessionId: 'session-B', clipId: 'clip-B', status: 'ready' }))
    // Delayed session A arrives after B is established
    store.applyState(makeState({ sessionId: 'session-A', clipId: 'clip-A', status: 'paused' }))
    // Store must still hold session B
    expect(store.current?.sessionId).toBe('session-B')
    expect(store.current?.clipId).toBe('clip-B')
  })

  it('race: stale session does not clear completedPattern', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState({ sessionId: 'session-B' }))
    store.completedPattern = makePattern()
    // Stale session arrives
    store.applyState(makeState({ sessionId: 'session-OLD', status: 'error' }))
    // Pattern must still be intact
    expect(store.completedPattern).not.toBeNull()
    expect(store.current?.sessionId).toBe('session-B')
  })
})
