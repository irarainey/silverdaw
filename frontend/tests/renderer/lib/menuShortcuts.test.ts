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
})
