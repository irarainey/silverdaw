import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import {
  SCRATCH_CROSSFADER_CURVE_VERSION,
  SCRATCH_PATTERN_VERSION,
  type ScratchPattern,
  type ScratchSessionStatePayload
} from '@shared/bridge-protocol'
import { canonicalizeScratchPattern } from '@/lib/scratch/scratchPatternCanonical'
import { useScratchNotationEditor } from '@/lib/scratch/useScratchNotationEditor'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'

function makeState(): ScratchSessionStatePayload {
  return {
    protocolVersion: 1,
    sessionId: 'session-1',
    clipId: 'clip-1',
    status: 'ready',
    positionUs: 0,
    durationUs: 1_000_000,
    platterTurns: 0,
    playbackRate: 0,
    crossfader: 0.5,
    ownerDeviceIdentifier: null,
    ownerDeck: null,
    touched: false
  }
}

function makePattern(): ScratchPattern {
  return {
    id: 'pattern-1',
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
      { timeUs: 500_000, turns: 0.5, touched: true },
      { timeUs: 1_000_000, turns: 1, touched: false }
    ],
    crossfader: [
      { timeUs: 0, value: 0 },
      { timeUs: 1_000_000, value: 1 }
    ]
  }
}

describe('useScratchNotationEditor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('undoes and redoes a notation edit while preserving draft dirty state', () => {
    const store = useScratchSessionStore()
    const pattern = makePattern()
    store.applyState(makeState())
    store.replacePattern(pattern)
    store.savedCanonicalBaseline = canonicalizeScratchPattern(pattern)
    const editor = useScratchNotationEditor(ref('session-1'))

    expect(editor.movePlatter(1, 500_000, 0.75)).toBe(true)
    expect(store.completedPattern?.platter[1]?.turns).toBe(0.75)
    expect(store.isSavedPatternDirty).toBe(true)

    expect(editor.undo()).toBe(true)
    expect(store.completedPattern?.platter[1]?.turns).toBe(0.5)
    expect(store.isSavedPatternDirty).toBe(false)

    expect(editor.redo()).toBe(true)
    expect(store.completedPattern?.platter[1]?.turns).toBe(0.75)
    expect(store.isSavedPatternDirty).toBe(true)
  })

  it('coalesces a pointer edit group into one undo step', () => {
    const store = useScratchSessionStore()
    store.applyState(makeState())
    store.replacePattern(makePattern())
    const editor = useScratchNotationEditor(ref('session-1'))

    editor.beginEditGroup()
    editor.movePlatter(1, 500_000, 0.6)
    editor.movePlatter(1, 500_000, 0.7)
    editor.endEditGroup()

    expect(editor.undo()).toBe(true)
    expect(store.completedPattern?.platter[1]?.turns).toBe(0.5)
    expect(editor.undo()).toBe(false)
  })
})
