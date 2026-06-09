import { describe, expect, it } from 'vitest'
import { useClipEditorReverseDraft } from '@/lib/clipEditor/useClipEditorReverseDraft'
import type { Clip } from '@/stores/projectStore'

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return { id: 'c1', durationMs: 1000, ...overrides } as Clip
}

describe('useClipEditorReverseDraft', () => {
  it('seeds forward for a clip with no reverse flag and reports no change', () => {
    const draft = useClipEditorReverseDraft()
    draft.initialise(makeClip())
    expect(draft.reversed.value).toBe(false)
    expect(draft.committed()).toBe(false)
    expect(draft.hasChanged.value).toBe(false)
  })

  it('seeds reversed from a reversed clip and reports no change until toggled', () => {
    const draft = useClipEditorReverseDraft()
    draft.initialise(makeClip({ reversed: true }))
    expect(draft.reversed.value).toBe(true)
    expect(draft.hasChanged.value).toBe(false)

    draft.toggle()
    expect(draft.reversed.value).toBe(false)
    expect(draft.committed()).toBe(false)
    expect(draft.hasChanged.value).toBe(true)
  })

  it('marks dirty when toggled away from a forward clip', () => {
    const draft = useClipEditorReverseDraft()
    draft.initialise(makeClip())
    draft.toggle()
    expect(draft.hasChanged.value).toBe(true)
    expect(draft.committed()).toBe(true)
  })

  it('resets to forward when initialised with null', () => {
    const draft = useClipEditorReverseDraft()
    draft.initialise(makeClip({ reversed: true }))
    draft.initialise(null)
    expect(draft.reversed.value).toBe(false)
    expect(draft.hasChanged.value).toBe(false)
  })
})
