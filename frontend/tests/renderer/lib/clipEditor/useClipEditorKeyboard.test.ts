import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useClipEditorKeyboard, type ClipEditorKeyboardDeps } from '@/lib/clipEditor/useClipEditorKeyboard'

function makeDeps(overrides: Partial<ClipEditorKeyboardDeps> = {}): {
  deps: ClipEditorKeyboardDeps
  spies: Record<string, ReturnType<typeof vi.fn>>
  open: { value: boolean }
  hasSel: { value: boolean }
  canGate: { value: boolean }
} {
  const open = { value: true }
  const hasSel = { value: false }
  const canGate = { value: false }
  const spies = {
    close: vi.fn(),
    clearSelection: vi.fn(),
    extendSelection: vi.fn(),
    nudgePlayhead: vi.fn(),
    togglePlay: vi.fn(),
    toggleLoop: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
    undoCropLocal: vi.fn(),
    redoCropLocal: vi.fn(),
    silenceSelection: vi.fn(),
    fullSelection: vi.fn()
  }
  const deps: ClipEditorKeyboardDeps = {
    isOpen: () => open.value,
    hasPlaybackSelection: () => hasSel.value,
    canGateSelection: () => canGate.value,
    silenceSelection: spies.silenceSelection,
    fullSelection: spies.fullSelection,
    close: spies.close,
    clearSelection: spies.clearSelection,
    extendSelection: spies.extendSelection as ClipEditorKeyboardDeps['extendSelection'],
    nudgePlayhead: spies.nudgePlayhead as ClipEditorKeyboardDeps['nudgePlayhead'],
    togglePlay: spies.togglePlay,
    toggleLoop: spies.toggleLoop,
    zoomIn: spies.zoomIn,
    zoomOut: spies.zoomOut,
    resetZoom: spies.resetZoom,
    undoCropLocal: spies.undoCropLocal,
    redoCropLocal: spies.redoCropLocal,
    ...overrides
  }
  return { deps, spies, open, hasSel, canGate }
}

interface KeyOpts {
  key?: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  repeat?: boolean
  editable?: boolean
}

function makeKey(opts: KeyOpts = {}): {
  e: KeyboardEvent
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
  blur: ReturnType<typeof vi.fn>
} {
  const preventDefault = vi.fn()
  const stopPropagation = vi.fn()
  const blur = vi.fn()
  const target = {
    isContentEditable: opts.editable === true,
    closest: (_sel: string) => (opts.editable ? {} : null),
    blur
  }
  const e = {
    key: opts.key ?? '',
    code: opts.code ?? '',
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    isComposing: opts.isComposing ?? false,
    repeat: opts.repeat ?? false,
    preventDefault,
    stopPropagation,
    target,
    composedPath: () => [target]
  } as unknown as KeyboardEvent
  return { e, preventDefault, stopPropagation, blur }
}

describe('useClipEditorKeyboard — onKeydown', () => {
  let h: ReturnType<typeof makeDeps>
  let kb: ReturnType<typeof useClipEditorKeyboard>

  beforeEach(() => {
    h = makeDeps()
    kb = useClipEditorKeyboard(h.deps)
  })

  it('ignores composing keystrokes', () => {
    const { e } = makeKey({ key: ' ', isComposing: true })
    kb.onKeydown(e)
    expect(h.spies.togglePlay).not.toHaveBeenCalled()
  })

  it('Escape blurs an editable target instead of closing', () => {
    const { e, blur } = makeKey({ key: 'Escape', editable: true })
    kb.onKeydown(e)
    expect(blur).toHaveBeenCalled()
    expect(h.spies.close).not.toHaveBeenCalled()
  })

  it('Escape clears an active selection before closing', () => {
    h.hasSel.value = true
    const { e, preventDefault } = makeKey({ key: 'Escape' })
    kb.onKeydown(e)
    expect(h.spies.clearSelection).toHaveBeenCalled()
    expect(h.spies.close).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalled()
  })

  it('Escape with no selection closes the dialog', () => {
    const { e } = makeKey({ key: 'Escape' })
    kb.onKeydown(e)
    expect(h.spies.close).toHaveBeenCalledTimes(1)
  })

  it('suppresses transport shortcuts while typing in a field', () => {
    const { e } = makeKey({ key: ' ', editable: true })
    kb.onKeydown(e)
    expect(h.spies.togglePlay).not.toHaveBeenCalled()
  })

  it('Ctrl+D clears the selection', () => {
    const { e } = makeKey({ key: 'd', ctrlKey: true })
    kb.onKeydown(e)
    expect(h.spies.clearSelection).toHaveBeenCalled()
  })

  it('Ctrl+Z undoes and Ctrl+Y / Ctrl+Shift+Z redo crop', () => {
    kb.onKeydown(makeKey({ key: 'z', ctrlKey: true }).e)
    expect(h.spies.undoCropLocal).toHaveBeenCalledTimes(1)
    kb.onKeydown(makeKey({ key: 'y', ctrlKey: true }).e)
    kb.onKeydown(makeKey({ key: 'z', ctrlKey: true, shiftKey: true }).e)
    expect(h.spies.redoCropLocal).toHaveBeenCalledTimes(2)
  })

  it('Space toggles play', () => {
    const { e, preventDefault, stopPropagation } = makeKey({ key: ' ' })
    kb.onKeydown(e)
    expect(h.spies.togglePlay).toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()
  })

  it('arrows nudge the playhead, snapping to beats unless Alt is held', () => {
    kb.onKeydown(makeKey({ key: 'ArrowLeft' }).e)
    expect(h.spies.nudgePlayhead).toHaveBeenLastCalledWith(-1, true)
    kb.onKeydown(makeKey({ key: 'ArrowRight', altKey: true }).e)
    expect(h.spies.nudgePlayhead).toHaveBeenLastCalledWith(1, false)
  })

  it('Shift+arrows extend the selection', () => {
    kb.onKeydown(makeKey({ key: 'ArrowRight', shiftKey: true }).e)
    expect(h.spies.extendSelection).toHaveBeenLastCalledWith(1, true)
    expect(h.spies.nudgePlayhead).not.toHaveBeenCalled()
  })

  it('+/-/0 control zoom and L toggles loop', () => {
    kb.onKeydown(makeKey({ key: '=' }).e)
    expect(h.spies.zoomIn).toHaveBeenCalled()
    kb.onKeydown(makeKey({ key: '-' }).e)
    expect(h.spies.zoomOut).toHaveBeenCalled()
    kb.onKeydown(makeKey({ key: '0' }).e)
    expect(h.spies.resetZoom).toHaveBeenCalled()
    kb.onKeydown(makeKey({ key: 'l' }).e)
    expect(h.spies.toggleLoop).toHaveBeenCalled()
  })

  it('S silences and F restores the selection when a range is gateable', () => {
    h.canGate.value = true
    kb.onKeydown(makeKey({ key: 's' }).e)
    expect(h.spies.silenceSelection).toHaveBeenCalledTimes(1)
    kb.onKeydown(makeKey({ key: 'F' }).e)
    expect(h.spies.fullSelection).toHaveBeenCalledTimes(1)
  })

  it('S / F do nothing without a gateable selection', () => {
    kb.onKeydown(makeKey({ key: 's' }).e)
    kb.onKeydown(makeKey({ key: 'f' }).e)
    expect(h.spies.silenceSelection).not.toHaveBeenCalled()
    expect(h.spies.fullSelection).not.toHaveBeenCalled()
  })

  it('Ctrl+S does not trigger the silence shortcut', () => {
    h.canGate.value = true
    kb.onKeydown(makeKey({ key: 's', ctrlKey: true }).e)
    expect(h.spies.silenceSelection).not.toHaveBeenCalled()
  })
})

describe('useClipEditorKeyboard — onWindowKeydownCapture', () => {
  let h: ReturnType<typeof makeDeps>
  let kb: ReturnType<typeof useClipEditorKeyboard>

  beforeEach(() => {
    h = makeDeps()
    kb = useClipEditorKeyboard(h.deps)
  })

  it('is a no-op when the dialog is closed', () => {
    h.open.value = false
    kb.onWindowKeydownCapture(makeKey({ code: 'Space' }).e)
    expect(h.spies.togglePlay).not.toHaveBeenCalled()
  })

  it('ignores keystrokes from editable targets', () => {
    kb.onWindowKeydownCapture(makeKey({ code: 'Space', editable: true }).e)
    expect(h.spies.togglePlay).not.toHaveBeenCalled()
  })

  it('Space toggles play and swallows the event', () => {
    const { e, preventDefault, stopPropagation } = makeKey({ code: 'Space' })
    kb.onWindowKeydownCapture(e)
    expect(h.spies.togglePlay).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()
  })

  it('does not re-trigger play on auto-repeat Space', () => {
    kb.onWindowKeydownCapture(makeKey({ code: 'Space', repeat: true }).e)
    expect(h.spies.togglePlay).not.toHaveBeenCalled()
  })

  it('captures Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z for crop undo/redo', () => {
    kb.onWindowKeydownCapture(makeKey({ key: 'z', ctrlKey: true }).e)
    expect(h.spies.undoCropLocal).toHaveBeenCalledTimes(1)
    kb.onWindowKeydownCapture(makeKey({ key: 'z', ctrlKey: true, shiftKey: true }).e)
    expect(h.spies.redoCropLocal).toHaveBeenCalledTimes(1)
  })

  it('ignores plain keys with no Ctrl/Cmd modifier', () => {
    kb.onWindowKeydownCapture(makeKey({ key: 'z' }).e)
    expect(h.spies.undoCropLocal).not.toHaveBeenCalled()
  })
})
