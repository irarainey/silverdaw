import { describe, expect, it, beforeEach } from 'vitest'
import { createScratchEditHistory } from '@/lib/scratch/scratchEditHistory'
import type { ScratchPattern } from '@shared/bridge-protocol'
import { SCRATCH_PATTERN_VERSION, SCRATCH_CROSSFADER_CURVE_VERSION } from '@shared/bridge-protocol'

function makePattern(id: string, turns: number = 0): ScratchPattern {
  return {
    id,
    name: 'Test',
    version: SCRATCH_PATTERN_VERSION,
    durationUs: 1_000_000,
    cropStartUs: 0,
    cropEndUs: 1_000_000,
    sourceOffsetTurns: 0,
    ownerDeck: 1,
    crossfaderCurve: SCRATCH_CROSSFADER_CURVE_VERSION,
    platter: [
      { timeUs: 0, turns, touched: true },
      { timeUs: 1_000_000, turns: turns + 1, touched: false }
    ],
    crossfader: [
      { timeUs: 0, value: 0 },
      { timeUs: 1_000_000, value: 1 }
    ]
  }
}

describe('ScratchEditHistory', () => {
  let history: ReturnType<typeof createScratchEditHistory>

  beforeEach(() => {
    history = createScratchEditHistory()
  })

  it('starts empty with no undo/redo', () => {
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
    expect(history.undoDepth()).toBe(0)
    expect(history.redoDepth()).toBe(0)
  })

  it('push enables undo', () => {
    history.push(makePattern('a'))
    expect(history.canUndo()).toBe(true)
    expect(history.undoDepth()).toBe(1)
  })

  it('undo returns previous state and enables redo', () => {
    const a = makePattern('a')
    const b = makePattern('b', 1)
    history.push(a)
    const restored = history.undo(b)
    expect(restored).toEqual(a)
    expect(history.canRedo()).toBe(true)
    expect(history.canUndo()).toBe(false)
  })

  it('redo returns next state', () => {
    const a = makePattern('a')
    const b = makePattern('b', 1)
    history.push(a)
    history.undo(b)
    const redone = history.redo(a)
    expect(redone).toEqual(b)
  })

  it('push after undo clears redo stack', () => {
    const a = makePattern('a')
    const b = makePattern('b', 1)
    const c = makePattern('c', 2)
    history.push(a)
    history.push(b)
    history.undo(c)
    expect(history.canRedo()).toBe(true)
    history.push(c)
    expect(history.canRedo()).toBe(false)
  })

  it('undo returns null when empty', () => {
    expect(history.undo(makePattern('x'))).toBeNull()
  })

  it('redo returns null when empty', () => {
    expect(history.redo(makePattern('x'))).toBeNull()
  })

  it('clear resets both stacks', () => {
    history.push(makePattern('a'))
    history.push(makePattern('b'))
    history.clear()
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
  })

  it('respects bounded depth (50)', () => {
    for (let i = 0; i < 60; i++) {
      history.push(makePattern(`p-${i}`, i))
    }
    expect(history.undoDepth()).toBe(50)
  })

  it('multiple undo/redo round trips are consistent', () => {
    const states = Array.from({ length: 5 }, (_, i) => makePattern(`s-${i}`, i))
    for (const s of states) history.push(s)

    let current = makePattern('final', 10)
    for (let i = states.length - 1; i >= 0; i--) {
      const prev = history.undo(current)
      expect(prev).toEqual(states[i])
      current = prev!
    }
    expect(history.canUndo()).toBe(false)
    expect(history.redoDepth()).toBe(5)
  })

  it('three edits then undo all then redo all preserves full chain', () => {
    const a = makePattern('a', 0)
    const b = makePattern('b', 1)
    const c = makePattern('c', 2)
    const d = makePattern('d', 3) // final "current" after 3 edits

    history.push(a) // before edit 1
    history.push(b) // before edit 2
    history.push(c) // before edit 3

    // Undo 3 times
    let current = d
    current = history.undo(current)!
    expect(current).toEqual(c)
    current = history.undo(current)!
    expect(current).toEqual(b)
    current = history.undo(current)!
    expect(current).toEqual(a)
    expect(history.canUndo()).toBe(false)
    expect(history.redoDepth()).toBe(3)

    // Redo 3 times
    current = history.redo(current)!
    expect(current).toEqual(b)
    current = history.redo(current)!
    expect(current).toEqual(c)
    current = history.redo(current)!
    expect(current).toEqual(d)
    expect(history.canRedo()).toBe(false)
    expect(history.undoDepth()).toBe(3)
  })

  it('interleaved undo/redo preserves correct states', () => {
    const a = makePattern('a', 0)
    const b = makePattern('b', 1)
    const c = makePattern('c', 2)
    const d = makePattern('d', 3)

    history.push(a)
    history.push(b)
    history.push(c)

    let current = d
    // Undo once
    current = history.undo(current)!
    expect(current).toEqual(c)
    // Redo once
    current = history.redo(current)!
    expect(current).toEqual(d)
    // Undo twice
    current = history.undo(current)!
    expect(current).toEqual(c)
    current = history.undo(current)!
    expect(current).toEqual(b)
    // Redo once
    current = history.redo(current)!
    expect(current).toEqual(c)
    expect(history.canRedo()).toBe(true)
    expect(history.canUndo()).toBe(true)
  })
})
