import { describe, expect, it } from 'vitest'
import { handleNotationKeydown } from '@/lib/scratch/scratchNotationKeyboard'
import type { ScratchNotationEditor, NotationSelection, NotationLane } from '@/lib/scratch/useScratchNotationEditor'
import type { ScratchPattern } from '@shared/bridge-protocol'
import { SCRATCH_PATTERN_VERSION, SCRATCH_CROSSFADER_CURVE_VERSION } from '@shared/bridge-protocol'
import { computed, ref } from 'vue'

function makePattern(overrides: Partial<ScratchPattern> = {}): ScratchPattern {
  return {
    id: 'test-1',
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
      { timeUs: 1_000_000, turns: 1.0, touched: false }
    ],
    crossfader: [
      { timeUs: 0, value: 0 },
      { timeUs: 500_000, value: 0.5 },
      { timeUs: 1_000_000, value: 1 }
    ],
    ...overrides
  }
}

function makeKeyEvent(key: string, opts: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}): KeyboardEvent {
  let defaultPrevented = false
  let propagationStopped = false
  return {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: false,
    target: null,
    preventDefault() { defaultPrevented = true },
    stopPropagation() { propagationStopped = true },
    get defaultPrevented() { return defaultPrevented },
    get _propagationStopped() { return propagationStopped }
  } as unknown as KeyboardEvent & { _propagationStopped: boolean }
}

function makeElement(tag: string): HTMLElement {
  return { tagName: tag, isContentEditable: false, blur() {} } as unknown as HTMLElement
}

function makeMockEditor(pattern: ScratchPattern | null, selection: NotationSelection | null = null): ScratchNotationEditor {
  const moved: Array<{ lane: string; index: number; time: number; value: number }> = []
  const added: Array<{ lane: string; time: number }> = []
  const deleted: boolean[] = []
  const toggled: number[] = []

  const sel = ref(selection)

  return {
    pattern: computed(() => pattern),
    selection: sel,
    selectKeyframe: (lane: NotationLane, index: number) => { sel.value = { lane, index } },
    clearSelection: () => { sel.value = null },
    movePlatter: (index: number, timeUs: number, turns: number) => { moved.push({ lane: 'platter', index, time: timeUs, value: turns }); return true },
    moveCrossfader: (index: number, timeUs: number, value: number) => { moved.push({ lane: 'crossfader', index, time: timeUs, value }); return true },
    addPlatter: (timeUs: number) => { added.push({ lane: 'platter', time: timeUs }); return true },
    addCrossfaderPoint: (timeUs: number) => { added.push({ lane: 'crossfader', time: timeUs }); return true },
    deleteSelected: () => { deleted.push(true); return true },
    togglePlatterTouch: (index: number) => { toggled.push(index); return true },
    _moved: moved,
    _added: added,
    _deleted: deleted,
    _toggled: toggled
  } as unknown as ScratchNotationEditor & {
    _moved: typeof moved
    _added: typeof added
    _deleted: typeof deleted
    _toggled: typeof toggled
  }
}

describe('handleNotationKeydown', () => {
  describe('native target bypass', () => {
    it('does not handle Delete when target is INPUT', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'platter', index: 1 })
      const event = makeKeyEvent('Delete')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('INPUT')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(false)
    })

    it('does not handle Ctrl+Z when target is BUTTON', () => {
      const editor = makeMockEditor(makePattern())
      const event = makeKeyEvent('z', { ctrlKey: true })
      ;(event as unknown as { target: HTMLElement }).target = makeElement('BUTTON')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(false)
    })

    it('Escape in INPUT blurs the input and stops propagation', () => {
      const editor = makeMockEditor(makePattern())
      let blurred = false
      const input = { tagName: 'INPUT', isContentEditable: false, blur() { blurred = true } } as unknown as HTMLElement
      const event = makeKeyEvent('Escape')
      ;(event as unknown as { target: HTMLElement }).target = input
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(true)
      expect(blurred).toBe(true)
    })
  })

  describe('delete', () => {
    it('handles Delete with selection', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'platter', index: 1 }) as ReturnType<typeof makeMockEditor>
      const event = makeKeyEvent('Delete')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(true)
      expect((editor as unknown as { _deleted: boolean[] })._deleted).toHaveLength(1)
    })

    it('does not handle Delete without selection', () => {
      const editor = makeMockEditor(makePattern(), null)
      const event = makeKeyEvent('Delete')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(false)
    })
  })

  describe('arrow keys move selected point', () => {
    it('ArrowRight nudges platter time forward', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'platter', index: 1 }) as ReturnType<typeof makeMockEditor>
      const event = makeKeyEvent('ArrowRight')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(true)
      const moved = (editor as unknown as { _moved: Array<{ time: number }> })._moved
      expect(moved).toHaveLength(1)
      expect(moved[0]!.time).toBe(510_000) // 500k + 10k step
    })

    it('ArrowUp nudges platter turns up', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'platter', index: 1 }) as ReturnType<typeof makeMockEditor>
      const event = makeKeyEvent('ArrowUp')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      const moved = (editor as unknown as { _moved: Array<{ value: number }> })._moved
      expect(moved[0]!.value).toBeCloseTo(0.51) // 0.5 + 0.01
    })

    it('Shift+ArrowRight nudges with large step', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'platter', index: 1 }) as ReturnType<typeof makeMockEditor>
      const event = makeKeyEvent('ArrowRight', { shiftKey: true })
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      const moved = (editor as unknown as { _moved: Array<{ time: number }> })._moved
      expect(moved[0]!.time).toBe(550_000) // 500k + 50k
    })

    it('does not handle arrows without selection', () => {
      const editor = makeMockEditor(makePattern(), null)
      const event = makeKeyEvent('ArrowRight')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(false)
    })

    it('moves crossfader point value with ArrowUp', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'crossfader', index: 1 }) as ReturnType<typeof makeMockEditor>
      const event = makeKeyEvent('ArrowUp')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      const moved = (editor as unknown as { _moved: Array<{ value: number }> })._moved
      expect(moved[0]!.value).toBeCloseTo(0.52) // 0.5 + 0.02
    })
  })

  describe('insert key adds points', () => {
    it('Insert adds a platter point at midpoint of adjacent keyframes', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'platter', index: 0 }) as ReturnType<typeof makeMockEditor>
      const event = makeKeyEvent('Insert')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(true)
      const added = (editor as unknown as { _added: Array<{ lane: string; time: number }> })._added
      expect(added[0]!.lane).toBe('platter')
      expect(added[0]!.time).toBe(250_000) // midpoint of [0, 500k]
    })

    it('Insert without selection adds at pattern midpoint', () => {
      const editor = makeMockEditor(makePattern(), null) as ReturnType<typeof makeMockEditor>
      const event = makeKeyEvent('Insert')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      const added = (editor as unknown as { _added: Array<{ lane: string; time: number }> })._added
      expect(added[0]!.lane).toBe('platter')
      expect(added[0]!.time).toBe(500_000)
    })
  })

  describe('toggle touch', () => {
    it('T toggles platter touch state', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'platter', index: 1 }) as ReturnType<typeof makeMockEditor>
      const event = makeKeyEvent('t')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(true)
      expect((editor as unknown as { _toggled: number[] })._toggled).toEqual([1])
    })

    it('T does nothing for crossfader selection', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'crossfader', index: 1 })
      const event = makeKeyEvent('t')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(false)
    })
  })

  describe('escape', () => {
    it('Escape clears selection and stops propagation', () => {
      const editor = makeMockEditor(makePattern(), { lane: 'platter', index: 0 })
      const event = makeKeyEvent('Escape')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(true)
      expect(editor.selection.value).toBe(null)
    })

    it('Escape without selection does not consume', () => {
      const editor = makeMockEditor(makePattern(), null)
      const event = makeKeyEvent('Escape')
      ;(event as unknown as { target: HTMLElement }).target = makeElement('DIV')
      const consumed = handleNotationKeydown(event, { editor, durationUs: 1_000_000 })
      expect(consumed).toBe(false)
    })
  })
})
