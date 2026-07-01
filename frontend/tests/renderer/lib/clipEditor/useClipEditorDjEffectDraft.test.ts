import { describe, expect, it } from 'vitest'
import { useClipEditorDjEffectDraft } from '@/lib/clipEditor/useClipEditorDjEffectDraft'
import type { Clip } from '@/stores/projectStore'

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return { id: 'c1', durationMs: 1000, ...overrides } as Clip
}

describe('useClipEditorDjEffectDraft', () => {
  it('seeds off for a clip with no effect and reports no change', () => {
    const draft = useClipEditorDjEffectDraft()
    draft.initialise(makeClip())
    expect(draft.brake.value).toBe(false)
    expect(draft.backspin.value).toBe(false)
    expect(draft.committedBrake()).toBe(false)
    expect(draft.committedBackspin()).toBe(false)
    expect(draft.hasChanged.value).toBe(false)
  })

  it('seeds brake from a braked clip and reports no change until toggled', () => {
    const draft = useClipEditorDjEffectDraft()
    draft.initialise(makeClip({ brake: true }))
    expect(draft.brake.value).toBe(true)
    expect(draft.hasChanged.value).toBe(false)

    draft.toggleBrake()
    expect(draft.brake.value).toBe(false)
    expect(draft.hasChanged.value).toBe(true)
  })

  it('turning brake on clears backspin (mutually exclusive)', () => {
    const draft = useClipEditorDjEffectDraft()
    draft.initialise(makeClip({ backspin: true }))
    expect(draft.backspin.value).toBe(true)

    draft.toggleBrake()
    expect(draft.brake.value).toBe(true)
    expect(draft.backspin.value).toBe(false)
    expect(draft.committedBrake()).toBe(true)
    expect(draft.committedBackspin()).toBe(false)
  })

  it('turning backspin on clears brake (mutually exclusive)', () => {
    const draft = useClipEditorDjEffectDraft()
    draft.initialise(makeClip({ brake: true }))

    draft.toggleBackspin()
    expect(draft.backspin.value).toBe(true)
    expect(draft.brake.value).toBe(false)
  })

  it('clear() turns both off', () => {
    const draft = useClipEditorDjEffectDraft()
    draft.initialise(makeClip({ backspin: true }))
    draft.clear()
    expect(draft.brake.value).toBe(false)
    expect(draft.backspin.value).toBe(false)
    // A backspin clip cleared to off is a real change.
    expect(draft.hasChanged.value).toBe(true)
  })

  it('marks dirty when toggled away from a clip with no effect', () => {
    const draft = useClipEditorDjEffectDraft()
    draft.initialise(makeClip())
    draft.toggleBackspin()
    expect(draft.hasChanged.value).toBe(true)
    expect(draft.committedBackspin()).toBe(true)
  })

  it('resets to off when initialised with null', () => {
    const draft = useClipEditorDjEffectDraft()
    draft.initialise(makeClip({ brake: true }))
    draft.initialise(null)
    expect(draft.brake.value).toBe(false)
    expect(draft.backspin.value).toBe(false)
    expect(draft.hasChanged.value).toBe(false)
  })
})
