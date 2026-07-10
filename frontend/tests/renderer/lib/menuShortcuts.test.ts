import { describe, expect, it } from 'vitest'
import { collectShortcutBindings } from '@/lib/menuShortcuts'

describe('collectShortcutBindings', () => {
  const actions = (): string[] =>
    collectShortcutBindings({ devToolsEnabled: false }).map((b) => b.action)

  it('binds ordinary menu accelerators (sanity check)', () => {
    const bound = actions()
    expect(bound).toContain('file.save')
    expect(bound).toContain('view.toggleFullScreen')
  })

  it('does NOT bind zoom accelerators owned by the global handler', () => {
    // Binding these would double-fire with App.vue's onGlobalShortcutKey:
    // both listeners are on window in the capture phase and stopPropagation
    // does not stop the sibling. Ctrl+0 in particular parses cleanly and
    // would otherwise be bound here.
    const bound = actions()
    expect(bound).not.toContain('view.zoomIn')
    expect(bound).not.toContain('view.zoomOut')
    expect(bound).not.toContain('view.zoomReset')
  })

  it('does not bind preset submenu entries (no accelerators)', () => {
    const bound = actions()
    expect(bound.some((a) => a.startsWith('view.zoomPreset:'))).toBe(false)
  })

  it('binds F12 only when developer tools are enabled', () => {
    expect(actions()).not.toContain('view.toggleDevTools')
    expect(
      collectShortcutBindings({ devToolsEnabled: true }).some(
        (binding) => binding.action === 'view.toggleDevTools' && binding.accel.key === 'f12'
      )
    ).toBe(true)
  })

  it('binds the Ctrl+D and Backspace aliases and the Trim / Zoom-to-Fit accelerators', () => {
    const bindings = collectShortcutBindings({ devToolsEnabled: false })
    const find = (action: string, pred: (b: (typeof bindings)[number]) => boolean) =>
      bindings.some((b) => b.action === action && pred(b))
    // Ctrl+D alias for the bare-D Duplicate.
    expect(find('edit.duplicateClip', (b) => b.accel.key === 'd' && b.accel.ctrl && !b.accel.shift)).toBe(true)
    // Backspace alias for Delete.
    expect(find('edit.deleteClip', (b) => b.accel.key === 'backspace')).toBe(true)
    // Trim Project to Last Clip on Ctrl+Shift+T.
    expect(find('edit.cropProjectToLastClip', (b) => b.accel.key === 't' && b.accel.ctrl && b.accel.shift)).toBe(true)
    // Zoom to Fit on Ctrl+F (menu-dispatched, not a global-handler zoom key).
    expect(find('view.zoomFit', (b) => b.accel.key === 'f' && b.accel.ctrl)).toBe(true)
  })
})
